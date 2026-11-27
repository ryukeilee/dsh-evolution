/**
 * Unified, model-free diagnostics for the dsh-evolution bundle.
 *
 * Every fact in a report is read from real state: the installed package files,
 * the resolved DSH host, the composed profile, the live Cordis context, the
 * Evolution data root, and the promotion journal. Nothing here sends data
 * anywhere, and nothing here writes unless `repair: true` is requested.
 *
 * Levels:
 * - `ok`            verified healthy
 * - `degraded`      the plugin keeps working, with a bounded, named limitation
 * - `blocked`       an essential guarantee cannot be met; do not run destructive flows
 * - `not-evaluated` this mode cannot observe the fact; the report says so
 *
 * A `blocked` check never silently continues: repairs are only proposed for
 * states whose rollback is provably safe, and a state whose safety cannot be
 * established is reported with `recoverable: false` and left untouched.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { constants as bufferConstants } from 'node:buffer';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { detectHostIdentity, packageVersionFromHostRoot, readPackageVersionFile } from './runtime-versions.js';
import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope, recoverInterruptedPromotion, isUsableMemoryEntry, inspectMemoryText, checkJournalBoundary, classifyPromotionJournal, classifyRollbackIntent, classifyRollbackReceipt, parseTargetClaim, classifyTargetClaim, TARGET_CLAIM_STATES, redactJsonParseMessage } from './orchestrator.js';
import { eventLogCheckpointPath, validRetentionDocument, inspectEventLogFloor, inspectRetentionContinuity, digestLogBytes } from './event-log-checkpoint.js';
import { probeSurfaces, SURFACE_PRIVATE } from './cordis-compat.js';
import { inspectArchiveIntegrity } from './archive-stage.js';
import {
  consumerActivationRows,
  consumerNeedsRestart,
  consumerRestartGuidance,
  consumerRevocationGuidance,
  consumerEligibilityGuidance,
  pendingRestartDetails,
  hostCompatible,
  isConsumerHostFailure,
  readConsumerState,
  readDisableState,
  readPromotedPlugin,
  readSharedIndex,
  sharingPaths,
  SHARED_CONSUMER_PROFILES,
} from './promoted-sharing.js';
import {
  USAGE_PROJECTION_ISSUE_TEXT,
  classifyUsageProjection,
  readUsageProjection,
  usageProjectionRemediation,
} from './capability-usage.js';
import { resolveEvolutionPaths } from './evolution-paths.js';

export { resolveEvolutionPaths };

/**
 * js-yaml ships as a bundle dependency so the doctor CLI works in a plugin-only
 * profile, where the host's own modules are not on the plain Node resolution
 * path. It is still loaded lazily: an install that lost it must degrade to an
 * explicit not-evaluated YAML check instead of crashing the diagnostic entry.
 */
let yamlModule;
async function loadYaml() {
  if (yamlModule === undefined) {
    try { yamlModule = await import('js-yaml'); } catch { yamlModule = null; }
  }
  return yamlModule;
}

export const DIAGNOSTIC_SCHEMA = 1;
export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const LEVEL = Object.freeze({ OK: 'ok', DEGRADED: 'degraded', BLOCKED: 'blocked', NOT_EVALUATED: 'not-evaluated' });

/**
 * Host versions this bundle is verified against.
 *
 * Derived from the declared alternatives in `peerDependencies` so the doctor's
 * answer cannot drift from the declaration, and the declaration only ever lists
 * a version after a real install, boot, core-flow, diagnostics, restart and
 * promotion/rollback acceptance run (see COMPATIBILITY.md). Only an exact
 * declared version is treated as verified, and any other host version is
 * blocked, never silently accepted.
 */
export const SUPPORTED_DSH_VERSIONS = Object.freeze(
  (readPeerRange()?.peers?.['@deepseek-ai/dsh'] || '').split('||').map((range) => range.trim()).filter(Boolean),
);

/** The complete tool surface this bundle registers. */
export const EVOLUTION_TOOL_NAMES = Object.freeze([
  'evolution_runtime_inspect',
  'evolution_plan',
  'evolution_propose',
  'evolution_trial',
  'evolution_probe',
  'evolution_measure',
  'evolution_revert',
  'evolution_promote',
  'evolution_canary_observe',
  'evolution_history',
  'evolution_maintain',
  'evolution_doctor',
]);

/** Host services `lib/index.js` and `lib/registration.js` inject. */
export const REQUIRED_RUNTIME_SERVICES = Object.freeze(['tools', 'dynamicCordisRunner', 'systemPrompt', 'loader', 'storageDomain', 'evolutionExperience']);

/**
 * Every loader row `cordis.patch.yml` must declare. Checking only the kernel
 * and guard rows let a patch that dropped the experience provider (or any
 * consumer/task row) still report `plugin.patch: ok`, even though the bundle
 * cannot supply its required runtime services.
 */
export const REQUIRED_LOADER_ENTRIES = Object.freeze({
  'evolution-experience': 'dsh-evolution/experience',
  'evolution-experience-history': 'dsh-evolution/experience-history',
  'evolution-orchestrator': 'dsh-evolution',
  'evolution-trust-root-guard': 'dsh-evolution/guard',
  'evolution-promoted-consumer': 'dsh-evolution/promoted-consumer',
  'evolution-desktop-task-host': 'dsh-evolution/desktop-task-host',
  'evolution-desktop-task-client': 'dsh-evolution/desktop-task-client',
});

/** Files that must ship for the bundle to load and to be diagnosable. */
const REQUIRED_PACKAGE_FILES = Object.freeze([
  'lib/index.js',
  'lib/guard.js',
  'lib/orchestrator.js',
  'lib/registration.js',
  'lib/domain-storage.js',
  'lib/promotion-include.js',
  'lib/diagnostics.js',
  'lib/cordis-compat.js',
  'lib/promoted-sharing.js',
  'lib/promoted-consumer.js',
  'lib/promoted-consumer-gc.js',
  'lib/compat/legacy-startup-drift.js',
  'scripts/doctor.mjs',
  'scripts/shared-plugins.mjs',
  'cordis.patch.yml',
]);

/** Host modules the bundle imports directly (blocking) or consumes as services. */
const HOST_MODULES = Object.freeze([
  { name: '@deepseek-ai/dsh', kind: 'host', blocking: true },
  { name: '@deepseek-ai/cordis', kind: 'import', blocking: true },
  { name: '@deepseek-ai/cordis-plugin-include', kind: 'import', blocking: true },
  { name: 'js-yaml', kind: 'import', blocking: true },
  { name: '@deepseek-ai/dsh-tools', kind: 'service', blocking: true },
  { name: '@deepseek-ai/dsh-cordis-host-runner', kind: 'service', blocking: true },
  { name: '@deepseek-ai/dsh-storage-domain', kind: 'service', blocking: true },
  { name: '@deepseek-ai/dsh-storage-json', kind: 'service', blocking: false },
]);

/**
 * Non-essential, explicitly documented limitations. These are reported as
 * evidence on a healthy check, never as a failure, so a healthy report stays
 * reachable while the limitation remains visible.
 */
export const KNOWN_DEGRADED_CAPABILITIES = Object.freeze([
  {
    id: 'evaluator-advisory',
    impact: 'The domain evaluator records a decision and hard-vetoes a detected regression, but promotionGates remains the production authority; independent host baseline/test metrics are not wired in.',
    resolution: 'Provide a DSH host surface that supplies independent baseline/test metrics for an experiment.',
  },
  {
    id: 'continuous-and-governance-not-wired',
    impact: 'lib/dockyard-domain/continuous and lib/dockyard-domain/governance are pure domain modules covered by unit tests and are not started by the orchestrator live loop.',
    resolution: 'Wire them into the live loop behind an explicit opt-in once the loop is designed.',
  },
  {
    id: 'host-only-promotion',
    impact: 'Client halves are rejected; promoted host code runs through a cooperative Function(hostCode)() gate that is not a security sandbox.',
    resolution: 'Requires an approval-aware durable composition contract from the host.',
  },
  {
    id: 'legacy-compat-adapters',
    impact: 'lib/compat/legacy-startup-drift.js and the legacy preset/default-path handling stay present but disabled by default.',
    resolution: 'Remove once no supported DSH layout publishes the legacy drift engine or preset layout.',
  },
  {
    id: 'internal-api-dependency',
    impact: 'Two introspection surfaces are private to Cordis by its own rule: ctx.events._hooks (no public listener enumeration exists) and the ctx.reflect._getImpl() fallback (used only when the documented ctx.reflect.store + Context.isolate path is absent). FiberState.ACTIVE is not importable (const enum, erased at runtime), so ACTIVE is decided from documented lifecycle fields. The official loader/Include members used for the mounted promoted row (EntryTree.resolve/root, Entry.fiber/options/disabled) are public but undocumented.',
    resolution: 'Replace ctx.events._hooks once the host publishes a public listener enumeration; every other surface already goes through a documented or explicitly classified path recorded in lib/cordis-compat.js.',
  },
]);

const HEX64 = /^[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{2,}$/;
const ROW_ID = /^evolution-promoted-[a-f0-9]{12}$/;
const STAGE_NAME = /^stage-[A-Za-z0-9-]{4,}$/;
const PROMOTED_ROW_FILE = /lib[/\\]index\.js$/;

export function readPeerRange(packageRoot = PACKAGE_ROOT) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return { version: manifest.version, peers: manifest.peerDependencies || {}, files: manifest.files || [], name: manifest.name };
  } catch {
    return { version: null, peers: {}, files: [], name: null };
  }
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function statSafe(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

/** Follow-symlink variant for places that copy or dereference the target. */
function statFollowSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function readJsonSafe(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (error) {
    // A parse message can quote the file's own bytes, and several checks copy
    // this message straight into evidence. The excerpt is user data.
    if (error instanceof SyntaxError) error.message = redactJsonParseMessage(error.message);
    return { error };
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Expand a leading `~` or `$HOME` the way EVOLUTION.md records legacy paths. */
function expandHome(value) {
  return String(value).replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$HOME(?=\/|$)/, os.homedir());
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Read-only inspection of the promotion lock directory (`lock.json`), never a
 * removal. The domain archive lock is a different protocol and is classified by
 * `inspectArchiveLock` in lib/domain-storage.js, the module that owns it; this
 * reader is deliberately not used for that path. */
function inspectLock(lockPath) {
  const stat = statSafe(lockPath);
  if (!stat) return { present: false };
  if (!stat.isDirectory()) {
    // A bare-pid file where the promotion lock directory should be: unreadable
    // as this protocol, which the caller reports as inactive.
    let raw = null;
    try { raw = fs.readFileSync(lockPath, 'utf8').trim(); } catch { /* unreadable */ }
    const numeric = raw === null || raw === '' ? null : Number(raw);
    const pid = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    return {
      present: true,
      kind: stat.isFile() ? 'file' : 'other',
      malformed: pid === null,
      owner: pid === null ? null : { pid },
      active: pid !== null && processAlive(pid),
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
    };
  }
  const meta = readJsonSafe(path.join(lockPath, 'lock.json'));
  const owner = meta.value || null;
  const pid = Number(owner?.pid);
  const sameHost = !owner?.hostname || owner.hostname === os.hostname();
  const alive = sameHost && processAlive(pid);
  const createdAt = Date.parse(owner?.createdAt || owner?.timestamp || '') || stat.mtimeMs;
  return {
    present: true,
    kind: 'directory',
    malformed: Boolean(meta.error),
    owner: owner ? { pid: Number.isInteger(pid) ? pid : null, hostname: owner.hostname || null, operation: owner.operation || null, createdAt: owner.createdAt || null } : null,
    active: alive,
    ageMs: Math.max(0, Date.now() - createdAt),
  };
}

/**
 * A full semver version. Numeric major, minor, patch and prerelease
 * identifiers may not carry a leading zero, so `1.02.3` and `1.0.0-01` do not
 * parse; build metadata is accepted and ignored.
 */
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemverVersion(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((identifier) => identifier.length > 1 && identifier[0] === '0' && /^\d+$/.test(identifier))) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

/** Compare two prerelease identifiers: numeric identifiers by value, a numeric
 * identifier below an alphanumeric one, alphanumeric ones in ASCII order. */
function comparePrecedenceIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semver precedence: the core triple, then the prerelease identifiers. A
 * version without a prerelease ranks above one with it. Build metadata is
 * ignored. */
function compareSemver(left, right) {
  const core = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (core !== 0) return core;
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return (left.prerelease.length === 0 ? 1 : 0) - (right.prerelease.length === 0 ? 1 : 0);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    // A larger identifier set outranks a prefix of itself.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const difference = comparePrecedenceIdentifiers(a, b);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseRangeComparator(token) {
  const match = /^(\^|~|>=|<=|>|<)?\s*(.+)$/.exec(token);
  if (!match) return null;
  const [, operator = '', target] = match;
  const version = parseSemverVersion(target);
  return version ? { operator, version } : null;
}

function comparatorMatches(version, comparator) {
  const precedence = compareSemver(version, comparator.version);
  const target = comparator.version;
  switch (comparator.operator) {
    case '': return precedence === 0;
    case '>=': return precedence >= 0;
    case '>': return precedence > 0;
    case '<=': return precedence <= 0;
    case '<': return precedence < 0;
    case '^': return precedence >= 0
      && (target.major > 0 ? version.major === target.major
        : target.minor > 0 ? version.major === 0 && version.minor === target.minor
          : version.major === 0 && version.minor === 0 && version.patch === target.patch);
    case '~': return precedence >= 0 && version.major === target.major && version.minor === target.minor;
    default: return false;
  }
}

/**
 * Semver range check for exact, `^`, `~`, `>=`, `>`, `<=`, `<` and `||`.
 *
 * Precedence follows the semver spec, including prerelease identifiers. A
 * prerelease version only satisfies a comparator set when one of that set's
 * comparators names the same major.minor.patch tuple with a prerelease, so
 * `4.0.5-alpha.2` satisfies `>=4.0.5-alpha.1 <5.0.0` while `4.0.6-alpha.1`
 * does not satisfy `>=4.0.5-alpha.1` (every other prerelease is excluded).
 */
export function satisfiesRange(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return false;
  const left = parseSemverVersion(version);
  if (!left) return false;
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean).map(parseRangeComparator);
    if (comparators.length === 0 || comparators.includes(null)) return false;
    if (!comparators.every((comparator) => comparatorMatches(left, comparator))) return false;
    if (left.prerelease.length === 0) return true;
    return comparators.some(({ version: target }) => target.prerelease.length > 0
      && target.major === left.major && target.minor === left.minor && target.patch === left.patch);
  });
}

// ---------------------------------------------------------------------------
// host / install resolution
// ---------------------------------------------------------------------------

function resolveFrom(anchor, specifier) {
  try {
    const require = createRequire(anchor.endsWith(path.sep) || anchor.endsWith('/') ? anchor : anchor);
    const resolved = require.resolve(specifier);
    const manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return { resolved, version: manifest.version || null, name: manifest.name || null };
  } catch (error) {
    return { error: error?.code || 'RESOLVE_FAILED', message: String(error?.message || error) };
  }
}

function executableOnPath(name) {
  const parts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    for (const candidate of [path.join(dir, name), path.join(dir, `${name}.cmd`), path.join(dir, `${name}.exe`)]) {
      const stat = statSafe(candidate);
      if (stat?.isFile() || stat?.isSymbolicLink()) return candidate;
    }
  }
  return null;
}

function packageRootFromCli(cliPath) {
  let real;
  try { real = fs.realpathSync(cliPath); } catch { real = cliPath; }
  let dir = path.dirname(real);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = path.join(dir, 'package.json');
    if (statSafe(manifest)?.isFile()) {
      const parsed = readJsonSafe(manifest);
      if (parsed.value?.name) return { packageRoot: dir, manifest: parsed.value };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { packageRoot: null, manifest: null };
}

// ---------------------------------------------------------------------------
// CLI wrapper resolution
// ---------------------------------------------------------------------------

const CLI_WRAPPER_MAX_DEPTH = 8;
const CLI_VERSION_PROBE_TIMEOUT_MS = 5000;
const CLI_SCRIPT_TEXT_LIMIT = 64 * 1024;
const CLI_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ASAR_HEADER_LIMIT = 16 * 1024 * 1024;
const ASAR_MANIFEST_LIMIT = 64 * 1024;
const cliVersionProbeCache = new Map();
const asarHeaderCache = new Map();
const CLI_CACHE_MAX = 64;

/** Cache identity: path plus file size and mtime, so an in-process host
 * upgrade cannot keep serving a stale version. Caches are memory-only. */
function fileIdentity(file) {
  try {
    const stat = fs.statSync(file);
    return `${file}\u0000${stat.size}\u0000${stat.mtimeMs}`;
  } catch {
    return `${file}\u0000na`;
  }
}

function cacheSet(cache, key, value) {
  if (cache.size >= CLI_CACHE_MAX) cache.clear();
  cache.set(key, value);
}

function readScriptHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, CLI_SCRIPT_TEXT_LIMIT));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function isShellScript(file) {
  const head = readScriptHead(file);
  if (!head) return false;
  const first = head.split('\n')[0].trim();
  // `#!/bin/sh`, `#!/usr/bin/env bash`, `#!/bin/bash -e` are wrappers; any
  // other interpreter stays fail-closed instead of being guessed at.
  return /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/[^\s]*\/)?(?:bash|sh|dash|zsh)(?:\s|$)/.test(first);
}

function shellTokens(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  let active = false;
  let glob = false;
  let special = false;
  const push = () => {
    if (!active) return;
    tokens.push({ value: current, glob, special });
    current = '';
    active = false;
    glob = false;
    special = false;
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') { quote = null; active = true; continue; }
      if (char === '\\') {
        const next = line[index + 1];
        if (next === undefined) current += '\\';
        else if (next === '$' || next === '`' || next === '"' || next === '\\') { current += next; index += 1; }
        else current += '\\';
        active = true;
        continue;
      }
      if (char === '`' || (char === '$' && line[index + 1] === '(')) return null;
      current += char;
      active = true;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (char === '\\') {
      if (index + 1 < line.length) { current += line[index + 1]; index += 1; }
      active = true;
      continue;
    }
    if (char === '`' || (char === '$' && line[index + 1] === '(')) return null;
    if (/\s/.test(char)) { push(); continue; }
    if (/[*?[]/.test(char)) glob = true;
    if (/[;&|<>()]/.test(char)) special = true;
    current += char;
    active = true;
  }
  if (quote) return null;
  push();
  return tokens;
}

function expandShellToken(token, variables) {
  return String(token).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (whole, braced, plain) => {
    const value = variables.get(braced || plain);
    return value === undefined ? whole : value;
  });
}

function cliResolutionErrorDetail(error) {
  switch (error) {
    case 'NO_EXEC_TARGET': return 'no exec target is attributable under the supported static grammar; unsupported control flow is fail-closed';
    case 'WRAPPER_TOO_DEEP': return 'the nested shell wrapper chain exceeds the supported depth';
    case 'WRAPPER_CYCLE': return 'the nested shell wrapper chain loops back to a wrapper already being expanded';
    case 'TARGET_NOT_DSH': return 'the launch target did not identify @deepseek-ai/dsh from a package manifest or ASAR host facts';
    case 'VERSION_UNAVAILABLE': return 'the package identifies @deepseek-ai/dsh but does not state a version, so this candidate cannot be ranked or attributed';
    case 'VERSION_INVALID': return 'the package states a @deepseek-ai/dsh version that is not valid semver, so this candidate cannot be ranked or attributed';
    case 'UNRESOLVED_EXEC_TARGET': return 'the launch command has no statically resolvable Node, Electron, shell, or binary target';
    default: return 'the launch branch could not be attributed to @deepseek-ai/dsh';
  }
}

function parameterExpansionEnd(body, start) {
  for (let index = start + 2; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') { index += 1; continue; }
    // Quotes, nested expansions and command substitutions need shell parsing
    // beyond this narrow one-line assignment grammar. Refuse them rather than
    // mistaking a later physical line for a launch command.
    if (char === '"' || char === "'" || char === '`') return null;
    if (char === '$' && (body[index + 1] === '{' || body[index + 1] === '(')) return null;
    if (char === '}') return index + 1;
  }
  return null;
}

function inlineCaseAssignmentName(body) {
  let index = 0;
  const skipSpace = () => { while (/\s/.test(body[index] || '')) index += 1; };
  if (body[index] === '(') { index += 1; skipSpace(); }
  const patternStart = index;
  let quote = null;
  for (; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (quote === '"' && char === '$' && body[index + 1] === '{') {
        const end = parameterExpansionEnd(body, index);
        if (end === null) return null;
        index = end - 1;
        continue;
      }
      if (quote === '"' && char === '$' && body[index + 1] === '(') return null;
      if (quote !== "'" && quote !== 'ansi' && char === '`') return null;
      if ((quote === 'ansi' || quote === '"') && char === '\\') { index += 1; continue; }
      if (char === (quote === 'ansi' ? "'" : quote)) quote = null;
      continue;
    }
    if (char === '`') return null;
    if (char === '\\') { index += 1; continue; }
    if (char === '$' && body[index + 1] === "'") { quote = 'ansi'; index += 1; continue; }
    if (char === '$' && body[index + 1] === '{') {
      const end = parameterExpansionEnd(body, index);
      if (end === null) return null;
      index = end - 1;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ')') break;
    if (/\s/.test(char)) {
      let next = index;
      while (/\s/.test(body[next] || '')) next += 1;
      if (body[next] !== ')') return null;
      index = next - 1;
      continue;
    }
    if (/[;&<>()]/.test(char)) return null;
  }
  if (quote || body[index] !== ')' || index === patternStart) return null;
  index += 1;
  skipSpace();
  const assignmentStart = index;
  quote = null;
  for (; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (quote === '"' && char === '$' && body[index + 1] === '{') {
        const end = parameterExpansionEnd(body, index);
        if (end === null) return null;
        index = end - 1;
        continue;
      }
      if (quote === '"' && char === '$' && body[index + 1] === '(') return null;
      if (quote !== "'" && quote !== 'ansi' && char === '`') return null;
      if ((quote === 'ansi' || quote === '"') && char === '\\') { index += 1; continue; }
      if (char === (quote === 'ansi' ? "'" : quote)) quote = null;
      continue;
    }
    if (char === '`') return null;
    if (char === '\\') { index += 1; continue; }
    if (char === '$' && body[index + 1] === "'") { quote = 'ansi'; index += 1; continue; }
    if (char === '$' && body[index + 1] === '{') {
      const end = parameterExpansionEnd(body, index);
      if (end === null) return null;
      index = end - 1;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char) || char === ';') break;
    if (/[&|<>()]/.test(char)) return null;
  }
  if (quote) return null;
  const assignment = body.slice(assignmentStart, index);
  if (!/^[A-Za-z_]\w*=/.test(assignment)) return null;
  skipSpace();
  if (!body.startsWith(';;', index)) return null;
  index += 2;
  skipSpace();
  if (!/^esac(?:\s+#.*)?$/.test(body.slice(index))) return null;
  return assignment.slice(0, assignment.indexOf('='));
}

function supportedCaseSelector(selector) {
  let quote = null;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\') { index += 1; continue; }
      if (char === '"') quote = null;
      else if (char === '`' || (char === '$' && (selector[index + 1] === '(' || selector[index + 1] === '{'))) return false;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '`' || (char === '$' && (selector[index + 1] === '(' || selector[index + 1] === '{'))) return false;
  }
  return quote === null;
}

/**
 * Read the `exec` targets of a POSIX shell wrapper, following the small
 * variable assignments those wrappers use for `$0` and `dirname .../..`.
 * Every target is returned; a wrapper with two branches must expose both
 * hosts so the caller can choose by version instead of by branch order.
 */
function parseShellWrapper(file) {
  const text = readScriptHead(file);
  if (!text) return [];
  const variables = new Map([['0', file]]);
  const execs = [];
  let heredoc = null;
  let caseDepth = 0;
  let caseBody = false;
  for (const [lineIndex, raw] of text.split('\n').entries()) {
    const lineNumber = lineIndex + 1;
    let line = raw.trim();
    if (heredoc) {
      // Text fed to a command is data, not control flow. An `exec` inside a
      // heredoc body must never become a host candidate. The terminator must
      // match exactly: only a trailing CR may be dropped, and `<<-` strips
      // leading tabs only (never spaces).
      const content = heredoc.stripTabs ? raw.replace(/^\t+/, '') : raw;
      if (content.replace(/\r$/, '') === heredoc.delimiter) heredoc = null;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (caseDepth > 0 && caseBody) {
      // A label on its own (`web)`) introduces a multi-line branch. Only a
      // direct exec is statically attributable; any other command may launch
      // a different host, so refuse the wrapper instead of keeping a fallback.
      if (/^;;\s*$/.test(line)) { caseBody = false; continue; }
      if (!/^exec\s+/.test(line)) return [];
    }
    // Only the actual `in` token after the single case word opens the
    // branch list. A greedy `.*\bin` would mistake a later pattern such as
    // `foo-in)` for that token and silently drop every preceding branch.
    const caseLine = /^case\s+((?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>()"'\\]+))\s+in(?=$|\s|\()(.*)$/.exec(line);
    if (/^case\b/.test(line)) {
      if (!caseLine || !supportedCaseSelector(caseLine[1])) return [];
      const body = (caseLine[2] || '').trim();
      if (!body) { caseDepth += 1; continue; }
      // A complete one-line case normally needs branch-aware shell parsing.
      // The one safe exception is a single plain variable assignment such as
      // `case "$arg" in --profile=*) profile=${arg#--profile=} ;; esac`:
      // it changes no launch target and contains no command to attribute.
      // Keep the grammar narrow; command substitutions, separators and
      // redirections still refuse the whole wrapper.
      const assignedVariable = inlineCaseAssignmentName(body);
      if (assignedVariable) {
        // The condition may or may not assign this variable. Invalidate any
        // statically known value so a later exec cannot use a stale path from
        // before the case; an unresolved variable fails closed.
        variables.delete(assignedVariable);
        continue;
      }
      // Refuse other complete one-line cases rather than accidentally
      // retaining only a later fallback.
      return [];
    }
    if (/^esac\b/.test(line)) {
      if (caseDepth === 0 || caseBody) return [];
      caseDepth -= 1;
      continue;
    }
    if (caseDepth > 0) {
      // `web) … ;; acp) …` contains two launch branches. The simple parser
      // cannot attribute them independently, so fail the wrapper closed.
      if (/;;\s*\S/.test(line)) return [];
      const label = /^(.+)\)\s*(.*)$/.exec(line);
      if (label) {
        const body = label[2].replace(/\s*;;\s*$/, '').trim();
        if (!body || body.startsWith('#')) { caseBody = true; continue; }
        if (!/^exec\s+/.test(body)) return [];
        line = body;
      }
    }
    // `if …; then exec …; fi` and similar inline launch branches cannot be
    // attributed by this line-oriented parser. Never skip them and keep a
    // later fallback as if it were the only host.
    if (/\bexec\b/.test(line)
      && !/^exec\s+/.test(line)
      && !/^(?:[A-Za-z_]\w*=[^\s]+\s+)+exec\s+/.test(line)) return [];
    const starts = [...line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)];
    // Two heredocs on one line (`cat <<A <<B`) have separate bodies; tracking
    // only one would leak the other's `exec` lines into control flow. Refuse
    // the whole wrapper rather than guess which body the command reads.
    if (starts.length > 1) return [];
    if (starts.length === 1) heredoc = { delimiter: starts[0][2], stripTabs: starts[0][0].startsWith('<<-') };
    const direct = /^([A-Za-z_]\w*)=(?:"\$0"|'\$0'|\$0|\$\{0\})$/.exec(line);
    if (direct) { variables.set(direct[1], file); continue; }
    const dirname = /^([A-Za-z_]\w*)=.*?dirname\s+(?:--\s+)?["']?\$([A-Za-z_]\w*)/.exec(line);
    if (dirname) {
      const base = variables.get(dirname[2]);
      if (base) {
        const after = line.slice(line.indexOf(`$${dirname[2]}`) + dirname[2].length + 1);
        // The shell quotes `")/../../.."`; without dropping the leading slash
        // path.resolve would treat it as an absolute path and jump to `/`.
        const relative = after.replace(/^["')]+/, '').split(/&&/)[0].trim().replace(/["']+$/, '').replace(/^\/+/, '');
        variables.set(dirname[1], path.resolve(path.dirname(base), relative || '.'));
      }
      continue;
    }
    const env = {};
    let body = null;
    const withEnv = /^((?:[A-Za-z_]\w*=[^\s]+\s+)+)exec\s+(.+)$/.exec(line);
    if (withEnv) {
      for (const pair of withEnv[1].trim().split(/\s+/)) {
        const equals = pair.indexOf('=');
        env[pair.slice(0, equals)] = pair.slice(equals + 1).replace(/^["']|["']$/g, '');
      }
      body = withEnv[2];
    } else {
      const plain = /^exec\s+(.+)$/.exec(line);
      if (plain) body = plain[1];
    }
    if (body === null) continue;
    const parsed = shellTokens(body);
    if (!parsed || parsed.length === 0) return { dynamic: true, line: lineNumber };
    const tokens = parsed.map((token) => ({ ...token, value: expandShellToken(token.value, variables) }));
    execs.push({ tokens, env, line: lineNumber });
  }
  return caseDepth === 0 && !caseBody ? execs : [];
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function staticTokenPath(token) {
  if (!token || typeof token.value !== 'string' || token.glob || token.special || /[$`\\]/.test(token.value)) return null;
  return normalizedPath(token.value);
}

function staticExecTarget(exec) {
  return staticTokenPath(exec.tokens[0]);
}

function unresolvedExecDetail(exec) {
  const target = staticExecTarget(exec);
  if (target && /(?:^|[/\\])node(?:\.exe)?$/.test(target)) {
    return 'the launch command resolves to Node but has no statically attributable JS script entry';
  }
  if (target && exec.env?.ELECTRON_RUN_AS_NODE === '1'
    && /(?:^|[/\\])(?:Electron|electron|Deep\s*Seek\s*Harness)(?:\.exe)?$/i.test(target)) {
    return 'the Electron launch command has no statically attributable JS or ASAR entry';
  }
  return cliResolutionErrorDetail('UNRESOLVED_EXEC_TARGET');
}

function cliEntryIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return index + 1;
    if (arg.startsWith('-')) {
      if (arg.includes('=') || arg === '--expose-internals') continue;
      return -1;
    }
    return index;
  }
  return -1;
}

function classifyCliExec(exec) {
  const absolute = exec.tokens.map(staticTokenPath);
  const values = exec.tokens.map((token) => token.value);
  const first = absolute[0];
  if (!first) return null;
  const env = exec.env || {};
  const isJs = (value) => /\.(?:m?js|cjs)$/.test(value);
  if (/(?:^|[/\\])node(?:\.exe)?$/.test(first)) {
    const args = values.slice(1);
    const evalFlags = ['-e', '-p', '--eval', '--print'];
    if (args.some((arg) => evalFlags.includes(arg) || arg.startsWith('--eval=') || arg.startsWith('--print='))) return null;
    const scriptIndex = cliEntryIndex(args);
    const script = scriptIndex >= 0 ? absolute[scriptIndex + 1] : null;
    return script && isJs(script) ? { kind: 'js', path: script, node: first, env } : null;
  }
  // Only an Electron binary can host an in-ASAR JS entry. The environment
  // variable alone does not turn `/bin/echo` into an Electron launcher.
  if (env.ELECTRON_RUN_AS_NODE === '1' && /(?:^|[/\\])(?:Electron|electron|Deep\s*Seek\s+Harness)(?:\.exe)?$/i.test(first)) {
    const args = values.slice(1);
    const entryIndex = cliEntryIndex(args);
    const script = entryIndex >= 0 ? absolute[entryIndex + 1] : null;
    if (script && (isJs(script) || script.includes('.asar/'))) {
      return { kind: 'electron', path: first, module: script, preArgs: args.slice(0, entryIndex).filter((token) => !token.startsWith('$')), env };
    }
    return null;
  }
  if (isShellScript(first)) return { kind: 'shell', path: first, env };
  if (isJs(first)) return { kind: 'js', path: first, node: process.execPath, env };
  // A command like `/bin/echo "$entry"` is just a binary. Promoting an
  // arbitrary .js argument to a Node entry would invent a host that was
  // never launched.
  return { kind: 'binary', path: first, env };
}

function asarFromEntry(entry) {
  const normalized = String(entry).split(path.sep).join('/');
  const marker = '.asar/';
  // Linear last-match search. The former /(.*\.asar)\/(.+)$/ backtracked
  // polynomially on a long path built from repeated ".asar/" fragments,
  // because the greedy `.*` and `(.+)$` had to re-split every candidate.
  // Keep the same semantics: the last ".asar/" with a non-empty internal
  // path wins; a trailing empty one falls back to the previous marker.
  let from = normalized.length;
  for (;;) {
    const index = normalized.lastIndexOf(marker, from);
    if (index < 0) return null;
    const internal = normalized.slice(index + marker.length);
    if (internal) {
      const root = path.resolve(normalized.slice(0, index + '.asar'.length));
      return { root, internal };
    }
    if (index === 0) return null;
    from = index - 1;
  }
}

/** Electron's asar patch makes a packaged .asar look like a virtual directory:
 * statSync reports isFile=false/size=0 and openSync throws ENOENT. Reading the
 * archive itself must bypass that patch; paths *inside* the archive are never
 * touched here. The previous flag is restored even when the read fails. */
function withNativeAsarFile(fn) {
  const previous = process.noAsar;
  process.noAsar = true;
  try { return fn(); } finally { process.noAsar = previous; }
}

function readAsarTree(asarRoot) {
  return withNativeAsarFile(() => {
    const key = fileIdentity(asarRoot);
    const cached = asarHeaderCache.get(key);
    if (cached) return cached;
    let fd;
    try {
      fd = fs.openSync(asarRoot, 'r');
      const fileSize = fs.fstatSync(fd).size;
      const intro = Buffer.alloc(16);
      fs.readSync(fd, intro, 0, 16, 0);
      // The header is a Chromium Pickle: byte 4 holds the header payload size
      // (JSON plus 4-byte alignment padding). The file data starts at 8 + that
      // size, not at 16 + jsonLength; conflating the two shifts every offset
      // when the JSON length is not already four-byte aligned.
      const headerSize = intro.readUInt32LE(4);
      const base = 8 + headerSize;
      if (!(headerSize > 0 && Number.isSafeInteger(base) && base >= 16 && base <= fileSize)) return null;
      const jsonLength = intro.readUInt32LE(12);
      if (!(jsonLength > 0 && jsonLength <= ASAR_HEADER_LIMIT && 16 + jsonLength <= fileSize)) return null;
      const buffer = Buffer.alloc(jsonLength);
      fs.readSync(fd, buffer, 0, jsonLength, 16);
      const tree = JSON.parse(buffer.toString('utf8'));
      const result = { tree, base };
      cacheSet(asarHeaderCache, key, result);
      return result;
    } catch { return null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
  });
}

function readAsarManifest(asarRoot, header, internalPath) {
  let node = header.tree;
  for (const part of internalPath.split('/')) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  const size = Number(node.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > ASAR_MANIFEST_LIMIT || node.unpacked) return null;
  return withNativeAsarFile(() => {
    let fd;
    try {
      fd = fs.openSync(asarRoot, 'r');
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, header.base + Number(node.offset));
      return JSON.parse(buffer.toString('utf8'));
    } catch { return null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } } }
  });
}

/** Package facts of an ASAR-backed host; packageRoot stays unknown on purpose. */
function readAsarHostFacts(entry) {
  const asar = asarFromEntry(entry);
  if (!asar) return null;
  const header = readAsarTree(asar.root);
  if (!header) return null;
  const marker = asar.internal.lastIndexOf('node_modules/');
  if (marker < 0) return null;
  const base = `${asar.internal.slice(0, marker)}node_modules`;
  const facts = {};
  for (const [key, name] of [['dsh', '@deepseek-ai/dsh'], ['cordis', '@deepseek-ai/cordis'], ['include', '@deepseek-ai/cordis-plugin-include']]) {
    const manifest = readAsarManifest(asar.root, header, `${base}/${name}/package.json`);
    if (manifest?.name === name && typeof manifest.version === 'string') facts[key] = manifest.version;
  }
  return Object.keys(facts).length > 0 ? facts : null;
}

/** Bounded `--version` probe. Never runs without a timeout. */
function probeCliVersion(target) {
  let command;
  let args;
  if (target.kind === 'js') {
    command = statSafe(target.node) ? target.node : process.execPath;
    args = [target.path, '--version'];
  } else if (target.kind === 'electron') {
    command = target.path;
    args = [...target.preArgs, target.module, '--version'];
  } else {
    command = target.path;
    args = ['--version'];
  }
  const electron = target.env?.ELECTRON_RUN_AS_NODE === '1' ? '1' : null;
  // Identity includes the on-disk stamps so a host upgraded in this process
  // cannot keep serving a version cached from the old bytes.
  const key = [fileIdentity(command), ...args.filter((arg) => path.isAbsolute(arg)).map(fileIdentity), electron].join('\u0001');
  if (cliVersionProbeCache.has(key)) return cliVersionProbeCache.get(key);
  let version = null;
  try {
    const result = spawnSync(command, args, {
      env: { ...process.env, ...(target.env || {}) },
      encoding: 'utf8',
      timeout: CLI_VERSION_PROBE_TIMEOUT_MS,
      // A probe that ignores SIGTERM must still be bounded; SIGKILL is the
      // only reliable deadline. This is the same trust boundary as dump-config.
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.status === 0) {
      const lines = `${result.stdout || ''}\n${result.stderr || ''}`.split('\n').map((line) => line.trim()).filter(Boolean);
      const candidate = lines[lines.length - 1] || '';
      // The shape regex keeps the output bounded to a version-looking line;
      // parseSemverVersion rejects leading zeroes and empty prerelease ids
      // that the loose shape would otherwise accept.
      if (CLI_VERSION_PATTERN.test(candidate) && parseSemverVersion(candidate)) version = candidate;
    }
  } catch { version = null; }
  cacheSet(cliVersionProbeCache, key, version);
  return version;
}

function terminalCliEntry(candidate, target, { allowVersionProbe = true } = {}) {
  // An Electron launcher is a native binary plus an in-ASAR JS entry. The JS
  // entry is what identifies the package; the binary is only how it is run.
  const entryPath = path.resolve(target.kind === 'electron' ? target.module : target.path);
  const meta = packageRootFromCli(entryPath);
  const hostFacts = readAsarHostFacts(entryPath);
  const isDsh = meta.manifest?.name === '@deepseek-ai/dsh' || Boolean(hostFacts?.dsh);
  const manifestVersion = meta.manifest?.version;
  const hasManifestVersion = Boolean(manifestVersion);
  let versionIdentity = isDsh && manifestVersion !== undefined && manifestVersion !== null ? manifestVersion : null;
  let version = isDsh && typeof manifestVersion === 'string' ? manifestVersion : null;
  let versionInvalid = isDsh && manifestVersion !== undefined && manifestVersion !== null
    && (typeof manifestVersion !== 'string' || manifestVersion.length === 0);
  if (hostFacts?.dsh) { version = hostFacts.dsh; versionIdentity = hostFacts.dsh; versionInvalid = false; }
  // Only an explicitly supplied CLI or the running host may be probed. A PATH
  // or profile candidate that merely looks like DSH must prove identity from a
  // manifest; a failed probe never turns it into a DSH host. Once a wrapper has
  // an unattributable branch, later branches are inspected statically only.
  if (isDsh && !version && !hasManifestVersion && allowVersionProbe && (candidate.explicit === true || candidate.source === 'running-process')) {
    version = probeCliVersion(target);
    if (version) { versionIdentity = version; versionInvalid = false; }
  }
  return {
    ...candidate,
    // The composition probe must run the path the user actually launches:
    // the outermost wrapper. The terminal entry is identity/version evidence
    // only, kept in realPath/entryPath.
    path: candidate.launchPath || candidate.path,
    entryPath,
    realPath: entryPath,
    target,
    isDsh,
    packageRoot: isDsh && !hostFacts ? meta.packageRoot : null,
    version: version || null,
    versionIdentity,
    versionInvalid,
    bin: isDsh ? meta.manifest?.bin || null : null,
    hostFacts: hostFacts || null,
  };
}

function cliVersionIdentity(candidate) {
  return candidate.versionIdentity ?? candidate.version ?? null;
}

function cliVersionLabel(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '<invalid>';
}

function expandCliCandidate(candidate, depth = 0, seen = new Set(), allowVersionProbe = true) {
  // Nested wrappers replace `path` with the next hop for expansion, but the
  // launch path must stay the outermost candidate for the composition probe.
  const launchPath = candidate.launchPath || candidate.path;
  let real = candidate.path;
  try { real = fs.realpathSync(candidate.path); } catch { /* keep the given path */ }
  if (seen.has(real)) return [{ ...candidate, realPath: real, isDsh: false, version: null, error: 'WRAPPER_CYCLE' }];
  seen.add(real);
  const stat = statSafe(candidate.path);
  if (depth >= CLI_WRAPPER_MAX_DEPTH) {
    return [{ ...candidate, realPath: real, isDsh: false, version: null, error: 'WRAPPER_TOO_DEEP' }];
  }
  if (!stat?.isFile()) {
    // An entry can be declared in a package manifest without its file being
    // installed (e.g. a synthetic host). The manifest is still a static DSH
    // proof; inspect it as a plain entry instead of guessing a wrapper or
    // probing a file that does not exist.
    const target = /\.(?:m?js|cjs)$/.test(real)
      ? { kind: 'js', path: real, node: process.execPath, env: {} }
      : { kind: 'binary', path: real, env: {} };
    return [terminalCliEntry(candidate, target, { allowVersionProbe })];
  }
  if (!isShellScript(candidate.path)) {
    const target = /\.(?:m?js|cjs)$/.test(real)
      ? { kind: 'js', path: real, node: process.execPath, env: {} }
      : { kind: 'binary', path: real, env: {} };
    return [terminalCliEntry(candidate, target, { allowVersionProbe })];
  }
  const expanded = [];
  const branchFailures = [];
  const parsed = parseShellWrapper(candidate.path);
  if (parsed?.dynamic) {
    return [{
      ...candidate, realPath: real, isDsh: false, version: null, error: 'UNRESOLVED_EXEC_TARGET',
      unresolvedBranches: [{
        wrapperPath: candidate.path,
        line: parsed.line,
        error: 'UNRESOLVED_EXEC_TARGET',
        detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
      }],
    }];
  }
  const execs = parsed;
  const requireAttributableVersions = execs.length > 1;
  let hasUnresolvedBranch = false;
  const addTerminalEntries = (entries) => {
    for (const entry of entries) {
      expanded.push(entry);
      const error = cliCandidateFailure(entry);
      if (error) {
        branchFailures.push({ path: entry.entryPath, error, detail: cliResolutionErrorDetail(error) });
        // An explicit CLI keeps the existing version/module gates: the package
        // is identified as DSH even when its version is missing or invalid.
        // Implicit multi-branch candidates still fail attribution closed.
        if (requireAttributableVersions
          && !(candidate.explicit === true && (error === 'VERSION_INVALID' || error === 'VERSION_UNAVAILABLE'))) hasUnresolvedBranch = true;
      }
    }
  };
  for (const exec of execs) {
    const target = classifyCliExec(exec);
    // A branch whose launch command cannot be resolved statically may route
    // the requested profile to another host. Inspect every branch so the
    // report can name each failure, but never keep a fallback as if it were
    // the only target.
    if (!target) {
      const targetPath = staticExecTarget(exec);
      branchFailures.push({
        wrapperPath: candidate.path,
        line: exec.line,
        ...(targetPath ? { path: targetPath } : {}),
        error: 'UNRESOLVED_EXEC_TARGET',
        detail: unresolvedExecDetail(exec),
      });
      hasUnresolvedBranch = true;
      continue;
    }
    if (target.kind === 'shell') {
      const nested = expandCliCandidate({ ...candidate, path: target.path, launchPath, via: [...(candidate.via || []), candidate.path] }, depth + 1, new Set(seen), allowVersionProbe && !hasUnresolvedBranch);
      const unresolved = nested.find((entry) => !entry.isDsh);
      if (unresolved) {
        if (unresolved.unresolvedBranches?.length > 0) branchFailures.push(...unresolved.unresolvedBranches);
        else {
          const error = unresolved.error || 'TARGET_NOT_DSH';
          branchFailures.push({ path: unresolved.entryPath || target.path, error, detail: cliResolutionErrorDetail(error) });
        }
        hasUnresolvedBranch = true;
      } else {
        addTerminalEntries(nested);
      }
    } else {
      const entry = terminalCliEntry({ ...candidate, launchPath, via: [...(candidate.via || []), candidate.path] }, target, { allowVersionProbe: allowVersionProbe && !hasUnresolvedBranch });
      if (entry.isDsh) addTerminalEntries([entry]);
      else {
        branchFailures.push({ path: entry.entryPath, error: 'TARGET_NOT_DSH', detail: cliResolutionErrorDetail('TARGET_NOT_DSH') });
        hasUnresolvedBranch = true;
      }
    }
  }
  // A proven non-DSH exec is still an unattributable launch branch (for
  // example `/usr/bin/env node …`). Keeping only another branch's DSH target
  // would make the same false profile attribution possible.
  if (hasUnresolvedBranch) {
    return [{ ...candidate, realPath: real, isDsh: false, version: null, error: 'UNRESOLVED_EXEC_TARGET', unresolvedBranches: branchFailures }];
  }
  return expanded.length > 0 ? expanded : [{ ...candidate, realPath: real, isDsh: false, version: null, error: 'NO_EXEC_TARGET' }];
}

/**
 * Find the DSH CLI with the highest resolvable version. Explicit input wins;
 * an unresolved host stays unknown instead of falling back to this bundle's
 * peer copy, which is not the host that boots a profile.
 */
export function resolveHostCli({ cliPath, dshHome, packageRoot = PACKAGE_ROOT, profileDir, runningEntry } = {}) {
  const candidates = [];
  if (cliPath) candidates.push({ path: path.resolve(cliPath), source: 'argument', explicit: true });
  if (process.env.DSH_CLI) candidates.push({ path: path.resolve(process.env.DSH_CLI), source: 'DSH_CLI', explicit: true });
  // Inside a running host the authoritative host is the one booting this
  // process; preferring it avoids trusting an unrelated global `dsh` on PATH.
  if (runningEntry) candidates.push({ path: path.resolve(runningEntry), source: 'running-process' });
  if (profileDir) {
    for (const name of ['dsh', 'dsh.cmd', 'dsh.exe']) {
      const candidate = path.join(profileDir, 'node_modules', '.bin', name);
      if (statSafe(candidate)) { candidates.push({ path: candidate, source: 'profile-node-modules' }); break; }
    }
  }
  const onPath = executableOnPath('dsh');
  if (onPath) candidates.push({ path: onPath, source: 'PATH' });

  const inspected = candidates.flatMap((candidate) => expandCliCandidate(candidate));
  const explicit = inspected.find((candidate) => candidate.explicit && candidate.isDsh);
  const running = inspected.find((candidate) => candidate.source === 'running-process' && candidate.isDsh);
  let selected = explicit || running || null;
  if (!selected) {
    for (const candidate of inspected) {
      if (!candidate.isDsh || !candidate.version) continue;
      const parsed = parseSemverVersion(candidate.version);
      if (!parsed) continue;
      const current = selected?.version ? parseSemverVersion(selected.version) : null;
      if (!current || compareSemver(parsed, current) > 0) selected = candidate;
    }
  }
  if (!selected) return { selected: null, reason: 'path-cli-unresolved', candidates: inspected, alternatives: [] };
  const alternatives = inspected.filter((candidate) => candidate !== selected && candidate.isDsh
    && cliVersionIdentity(candidate) && cliVersionIdentity(candidate) !== cliVersionIdentity(selected));
  return { selected, reason: null, candidates: inspected, alternatives };
}

export function defaultRunDumpConfig({ cliPath, dshHome, profile, timeoutMs = 120000 }) {
  // A wrapper is an executable shell script, not a Node module. Running it
  // through `node` would fail to parse and make a healthy host look blocked.
  // The target can also be a suffixless symlink to a JS entry: node can run
  // the resolved file even when the link itself is not executable.
  let real = cliPath;
  try { real = fs.realpathSync(cliPath); } catch { /* keep the given path */ }
  const jsTarget = /\.([cm]?js)$/.test(real) ? real : null;
  const nodeScript = Boolean(jsTarget) && !isShellScript(cliPath);
  const command = nodeScript ? process.execPath : cliPath;
  const args = nodeScript ? [jsTarget, '--profile', profile, '--dump-config'] : ['--profile', profile, '--dump-config'];
  const result = spawnSync(command, args, {
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

/**
 * Parse `dsh --dump-config` output: bundle sections and the entries inside.
 *
 * One bundle can be dumped as more than one section when a profile patch
 * targets it: the CLI emits `# == dsh-evolution, patched by <path>` holding the
 * patched entries and `# == dsh-evolution` holding the rest. Sections are
 * therefore merged by base name (the title up to the first comma), so the
 * caller sees one `dsh-evolution` layer carrying every entry in dump order.
 * `titles` keeps the raw headers in order; each section records the raw titles
 * it was merged from and whether any of them carried a patch marker.
 *
 * Each entry also carries `eventBridgeWriter`, the tri-state result of reading
 * `config.eventBridgeWriter` (see `eventBridgeWriterFromConfig`). Only the one
 * resolved scalar is kept: a config block can carry values this report must not
 * reproduce, so the raw lines stay local.
 */
export function parseComposedProfile(dump) {
  const sections = new Map();
  const titles = [];
  let current = null;
  const lines = String(dump || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = /^# == (.+)$/.exec(line);
    if (header) {
      const raw = header[1].trim();
      const base = raw.split(',')[0].trim();
      titles.push(raw);
      current = sections.get(base);
      if (!current) {
        current = { title: base, rawTitles: [], patched: false, entries: [], startLine: index + 1 };
        sections.set(base, current);
      }
      current.rawTitles.push(raw);
      if (raw !== base) current.patched = true;
      continue;
    }
    const entry = /^- id: (.+)$/.exec(line);
    if (entry && current) {
      let name = null;
      let disabled = null;
      let entryIndent = null;
      let configInline = null;
      let configBlock = null;
      let configEnded = false;
      let configDuplicated = false;
      for (let cursor = index + 1; cursor < lines.length && !/^- id: |^# == /.test(lines[cursor]); cursor += 1) {
        const candidate = lines[cursor];
        if (entryIndent === null && candidate.trim() !== '') {
          const firstIndent = /^(\s*)\S/.exec(candidate);
          entryIndent = firstIndent ? firstIndent[1].length : 0;
        }
        // Only the entry's own scalar keys count. A nested `config.disabled`
        // or `extra.name` is a different mapping and must not decide whether
        // this loader entry is enabled or what module it mounts.
        const nameMatch = /^(\s+)name:\s*(.+)$/.exec(candidate);
        if (nameMatch && name === null && nameMatch[1].length === entryIndent) name = nameMatch[2].trim().replace(/^['"]|['"]$/g, '');
        const disabledMatch = /^(\s+)disabled:\s*(.+)$/.exec(candidate);
        if (disabledMatch && disabled === null && disabledMatch[1].length === entryIndent) disabled = disabledMatch[2].trim();
        const configMatch = /^(\s+)config:(.*)$/.exec(candidate);
        // Only the entry's own `config:` key counts: a `config:` nested under
        // another key (for example `extra.config`) is a different config and
        // says nothing about what this entry's loader config holds.
        if (configMatch && configMatch[1].length === entryIndent) {
          // A second `config:` key in the same entry is a duplicate YAML key:
          // which one the loader keeps is not something this reader guesses.
          if (configInline !== null || configBlock !== null) { configDuplicated = true; continue; }
          const inline = configMatch[2].trim();
          if (inline === '') configBlock = { indent: configMatch[1].length, lines: [] };
          else configInline = inline;
          continue;
        }
        if (configBlock && !configEnded) {
          // A blank line inside a block mapping is not the end of the block.
          if (candidate.trim() === '') continue;
          const indentMatch = /^(\s*)\S/.exec(candidate);
          const indent = indentMatch ? indentMatch[1].length : 0;
          // A line at or left of `config:` is the next sibling key, so the
          // config block is over; deeper lines are collected and filtered later.
          if (indent <= configBlock.indent) { configEnded = true; continue; }
          configBlock.lines.push(candidate);
        }
      }
      current.entries.push({ id: entry[1].trim(), name, disabled, eventBridgeWriter: eventBridgeWriterFromConfig({ inline: configInline, block: configBlock, duplicated: configDuplicated }) });
    }
  }
  return { sections, titles };
}

const undeclaredWriter = () => ({ writer: null, unreadable: false });
const unreadableWriter = (reason) => ({ writer: null, unreadable: true, reason });

/** YAML 1.x scalars that are not strings; a writer name is always a string. */
function isYamlNonStringScalar(token) {
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(token)) return true;
  if (/^[-+]?[0-9][0-9_]*$/.test(token)) return true;
  if (/^[-+]?(?:\.[0-9_]+|[0-9][0-9_]*(?:\.[0-9_]*)?)(?:[eE][-+]?[0-9]+)?$/.test(token)) return true;
  if (/^[-+]?\.(?:inf|nan)$/i.test(token)) return true;
  if (/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt ].*)?$/.test(token)) return true;
  return false;
}

/**
 * Read one YAML scalar as a writer name, or report why it cannot be read.
 *
 * Only a plain or quoted string yields a value: a tag, anchor, alias, block
 * scalar, flow collection, template expression, comment ambiguity or non-string
 * scalar is `unreadable`, because the runtime would see a different value than
 * this reader can recover from the dump.
 */
function readConfigWriterScalar(text) {
  const raw = text.trim();
  if (raw === '') return undeclaredWriter();
  if (raw.startsWith('!')) return unreadableWriter('yaml-tag');
  if (raw.startsWith('&') || raw.startsWith('*')) return unreadableWriter('yaml-anchor');
  if (raw.startsWith('|') || raw.startsWith('>')) return unreadableWriter('block-scalar');
  if (raw.includes('${') || raw.includes('{{')) return unreadableWriter('template');
  if (raw.startsWith('[') || raw.startsWith('{')) return unreadableWriter('flow-collection');
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    // A quoted scalar is kept verbatim: no trimming of what the quotes hold,
    // and no attempt to reverse an escape this reader cannot invert exactly.
    if (raw.length < 2 || raw[raw.length - 1] !== quote) return unreadableWriter('unterminated-quote');
    const inner = raw.slice(1, -1);
    if (inner.includes('\\')) return unreadableWriter('escaped-quote-value');
    if (quote === "'" && inner.includes("''")) return unreadableWriter('escaped-single-quote');
    return inner === '' ? undeclaredWriter() : { writer: inner, unreadable: false };
  }
  if (raw.startsWith('#')) return unreadableWriter('comment');
  if (/\s#/.test(raw)) return unreadableWriter('inline-comment-ambiguous');
  if (isYamlNonStringScalar(raw)) return unreadableWriter('non-string-scalar');
  return { writer: raw, unreadable: false };
}

/**
 * Read `config.eventBridgeWriter` from one entry's config, in three states:
 *
 *   `{ writer: <string> }`                     the dump states exactly that value
 *   `{ writer: null, unreadable: false }`      the entry does not declare one
 *   `{ writer: null, unreadable: true, reason }` the dump does not determine it
 *
 * Only a direct child key of a block `config:` counts. A nested mapping (for
 * example `other.eventBridgeWriter`) is a different key and is ignored, a key
 * spelled in an equivalent but non-canonical way (`"eventBridgeWriter"`,
 * `'eventBridgeWriter'`, `eventBridgeWriter :`) resolves to the same YAML key
 * at runtime and is therefore unreadable rather than treated as undeclared,
 * and a key that appears twice or behind an inline `config:` is unreadable
 * rather than guessed, because the runtime would bind whichever the loader
 * resolved.
 */
function eventBridgeWriterFromConfig({ inline, block, duplicated } = {}) {
  // The dump spells the key as characters, not as a parsed YAML key: take the
  // text before the first colon, strip one layer of surrounding quotes, and
  // accept only the verbatim spelling. A spelling that normalizes back to the
  // same key is a key the runtime would bind, so it is unreadable here; any
  // other key (a case variant, a different name) is not this key at all.
  const eventBridgeWriterKeys = (lines) => {
    const found = [];
    for (const line of lines) {
      const split = /^(\s*)([^:]*):(.*)$/.exec(line);
      if (!split) continue;
      const keyText = split[2];
      if (keyText === 'eventBridgeWriter') { found.push({ canonical: true, scalar: split[3] }); continue; }
      const trimmed = keyText.trim();
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      const quoted = trimmed.length >= 2 && (first === "'" || first === '"') && (last === "'" || last === '"');
      const normalized = quoted ? trimmed.slice(1, -1) : trimmed;
      if (normalized === 'eventBridgeWriter') found.push({ canonical: false, scalar: split[3] });
    }
    return found;
  };
  if (duplicated) return unreadableWriter('duplicate-config-key');
  if (inline !== null && inline !== undefined) return unreadableWriter('inline-config');
  if (!block) return undeclaredWriter();
  let directIndent = null;
  const direct = [];
  for (const line of block.lines) {
    if (line.trim() === '') continue;
    const indent = /^(\s*)\S/.exec(line)[1].length;
    if (directIndent === null) directIndent = indent;
    // Deeper lines belong to a nested mapping of a direct key, never to this
    // mapping's own keys, so they are ignored entirely.
    else if (indent < directIndent) return unreadableWriter('inconsistent-indent');
    if (indent === directIndent) direct.push(line);
  }
  const keys = eventBridgeWriterKeys(direct);
  if (keys.length === 0) return undeclaredWriter();
  // A verbatim key next to a non-canonical spelling of the same key is still
  // the same YAML key twice: which one the loader keeps is not guessed here.
  if (keys.length > 1) return unreadableWriter('duplicate-key');
  return keys[0].canonical ? readConfigWriterScalar(keys[0].scalar) : unreadableWriter('non-canonical-key');
}

/**
 * Read the event-bridge writer the composed profile configures, in the same
 * three states `eventBridgeWriterFromConfig` reports.
 *
 * The runtime binds the bridge to `config.eventBridgeWriter || DEFAULT` after
 * the profile is resolved, so a guess here would recreate the doctor/runtime
 * disagreement this reader exists to remove. A profile that names more than one
 * `evolution-orchestrator` entry, or states the key behind an inline config,
 * a YAML tag or a template expression, is `unreadable` and never defaulted.
 */
export function composedEventBridgeWriter(composed) {
  const section = composed?.sections?.get('dsh-evolution');
  if (!section) return undeclaredWriter();
  const entries = section.entries.filter((candidate) => candidate.id === 'evolution-orchestrator');
  if (entries.length === 0) return undeclaredWriter();
  if (entries.length > 1) return unreadableWriter('duplicate-entry');
  return entries[0].eventBridgeWriter;
}

// ---------------------------------------------------------------------------
// json / jsonl integrity
// ---------------------------------------------------------------------------

export function inspectJsonLines(text) {
  const records = [];
  const lines = String(text ?? '').split('\n');
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === '';
  const body = endsWithNewline ? lines.slice(0, -1) : lines.slice();
  body.forEach((line, index) => {
    if (line.trim() === '') { records.push({ line: index + 1, empty: true }); return; }
    try { records.push({ line: index + 1, value: JSON.parse(line) }); } catch (error) { records.push({ line: index + 1, error: redactJsonParseMessage(String(error?.message ?? error)) }); }
  });
  return {
    records,
    lineCount: body.length,
    invalid: records.filter((record) => record.error),
    complete: !records.some((record) => record.error),
    truncatedTail: !endsWithNewline && body.length > 0 && Boolean(body[body.length - 1].trim()),
  };
}

// LF is the ASCII byte 0x0a and cannot occur inside a UTF-8 multibyte code
// point. Splitting on that byte and decoding each complete line therefore
// matches decoding the whole file before splitting on "\n"; chunks may still
// split a code point, so the unfinished line bytes are retained until LF. Both
// the event bridge and the cold-history JSONL scans read a file through it, so
// neither materialises the file as one string.
const JSONL_SCAN_CHUNK_BYTES = 1 << 20;
/** The timestamp shape the plugin's producers write; only these take part in a
 *  reported oldest/newest range. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

function scanJsonLinesFile(file, onLine) {
  const descriptor = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(JSONL_SCAN_CHUNK_BYTES);
  let pending = [];
  let pendingBytes = 0;
  let lineCount = 0;
  let lineNumber = 1;
  let lastLine = '';
  let sawBytes = false;
  let lastByte = null;
  let hasCompletePrefix = false;

  const appendPending = (bytes) => {
    if (bytes.length === 0) return;
    pending.push(Buffer.from(bytes));
    pendingBytes += bytes.length;
  };
  const takeLine = (bytes) => {
    if (pendingBytes === 0) return bytes.toString('utf8');
    if (bytes.length === 0) return Buffer.concat(pending, pendingBytes).toString('utf8');
    return Buffer.concat([...pending, bytes], pendingBytes + bytes.length).toString('utf8');
  };
  const finishLine = (bytes) => {
    const line = takeLine(bytes);
    pending = [];
    pendingBytes = 0;
    lastLine = line;
    onLine(line, lineNumber);
    lineNumber += 1;
    lineCount += 1;
  };

  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      sawBytes = true;
      lastByte = chunk[bytesRead - 1];
      let start = 0;
      let index = chunk.indexOf(0x0a, start);
      while (index !== -1 && index < bytesRead) {
        finishLine(chunk.subarray(start, index));
        hasCompletePrefix = true;
        start = index + 1;
        index = chunk.indexOf(0x0a, start);
      }
      appendPending(chunk.subarray(start, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }

  // String(text).split("\n") has one empty element for an empty file. A
  // trailing LF's final empty split element is removed by inspectJsonLines,
  // while an unterminated final line (including an empty one) is counted.
  if (!sawBytes || lastByte !== 0x0a) finishLine(Buffer.alloc(0));
  return {
    lineCount,
    truncatedTail: lastByte !== 0x0a && Boolean(lastLine.trim()),
    hasCompletePrefix,
  };
}

// Cold-history integrity needs only counts, not retained payload objects.
function inspectJsonLinesSummary(text) {
  const source = String(text ?? '');
  const endsWithNewline = source.endsWith('\n');
  let start = 0;
  let lineCount = 0;
  let invalid = 0;
  let lastLine = '';
  do {
    const end = source.indexOf('\n', start);
    const line = source.slice(start, end === -1 ? source.length : end);
    lastLine = line;
    lineCount += 1;
    if (line.trim() !== '') {
      try { JSON.parse(line); } catch { invalid += 1; }
    }
    if (end === -1) break;
    start = end + 1;
  } while (start < source.length);
  return { lineCount, invalid, truncatedTail: !endsWithNewline && Boolean(lastLine.trim()) };
}

// One UTF-16 code unit per input byte is the largest a UTF-8 decode produces
// (valid sequences produce fewer; an invalid byte becomes one replacement
// character), so a file at or below this size can always become the single
// string `readFileSync(file, "utf8")` used to build. A larger file keeps that
// whole-file read: whether the string limit stops it is itself part of the old
// result, and reporting counts for it would silently change a file the previous
// implementation reported as unreadable.
const MAX_WHOLE_FILE_TEXT_BYTES = bufferConstants.MAX_STRING_LENGTH;

/**
 * The cold-history summary of one JSONL file, read the way `scanJsonLinesFile`
 * reads the event bridge: LF-separated bytes decoded line by line, so the whole
 * file never exists as one string. Splitting on the LF byte and decoding each
 * complete line yields the same text the whole-file read produced (including
 * invalid UTF-8 replacement and CRLF line ends), and each non-empty line is
 * still passed to `JSON.parse`, so the counts and the unterminated-tail verdict
 * are those of `inspectJsonLinesSummary`.
 */
function inspectJsonLinesFileSummary(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* the scan below reports the read error */ }
  // Directories, FIFOs, devices and files whose decoded text the old whole-file
  // string could not hold keep the original read and its original errors.
  if (stat !== null && (!stat.isFile() || stat.size > MAX_WHOLE_FILE_TEXT_BYTES)) {
    return inspectJsonLinesSummary(fs.readFileSync(file, 'utf8'));
  }
  let invalid = 0;
  const scanned = scanJsonLinesFile(file, (lineText) => {
    if (lineText.trim() === '') return;
    try { JSON.parse(lineText); } catch { invalid += 1; }
  });
  return { lineCount: scanned.lineCount, invalid, truncatedTail: scanned.truncatedTail };
}

// ---------------------------------------------------------------------------
// report assembly
// ---------------------------------------------------------------------------

function createReport({ mode, plugin }) {
  return {
    schema: DIAGNOSTIC_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode,
    plugin,
    status: 'healthy',
    partial: false,
    summary: { ok: 0, degraded: 0, blocked: 0, notEvaluated: 0 },
    checks: [],
    degradedCapabilities: [...KNOWN_DEGRADED_CAPABILITIES],
    coverage: { evaluated: [], notEvaluated: [] },
    repairs: [],
    repairsApplied: [],
  };
}

function addCheck(report, check) {
  const entry = {
    id: check.id,
    category: check.category,
    level: check.level,
    summary: check.summary,
    evidence: check.evidence ?? {},
    ...(check.remediation ? { remediation: check.remediation } : {}),
    ...(check.recoverable !== undefined ? { recoverable: check.recoverable } : {}),
    ...(check.repair ? { repair: check.repair } : {}),
  };
  report.checks.push(entry);
  if (entry.level === LEVEL.OK) report.summary.ok += 1;
  else if (entry.level === LEVEL.DEGRADED) report.summary.degraded += 1;
  else if (entry.level === LEVEL.BLOCKED) report.summary.blocked += 1;
  else { report.summary.notEvaluated += 1; report.partial = true; report.coverage.notEvaluated.push({ id: entry.id, reason: entry.evidence.reason || 'not observable in this mode' }); }
  if (entry.level !== LEVEL.NOT_EVALUATED) report.coverage.evaluated.push(entry.id);
  if (entry.repair && entry.level !== LEVEL.OK) report.repairs.push({ check: entry.id, ...entry.repair });
  return entry;
}

function finalize(report) {
  report.status = report.summary.blocked > 0 ? 'blocked' : report.summary.degraded > 0 ? 'degraded' : 'healthy';
  return report;
}

// ---------------------------------------------------------------------------
// individual diagnostic areas
// ---------------------------------------------------------------------------

function diagnosePackage(report, { packageRoot }) {
  const manifest = readJsonSafe(path.join(packageRoot, 'package.json'));
  if (manifest.error) {
    addCheck(report, {
      id: 'plugin.package', category: 'plugin', level: LEVEL.BLOCKED,
      summary: 'The bundle package manifest could not be read.',
      evidence: { packageRoot, error: String(manifest.error.message || manifest.error) },
      remediation: 'Reinstall the bundle tarball.',
    });
    return { version: null, peers: {} };
  }
  const missing = REQUIRED_PACKAGE_FILES.filter((file) => !statSafe(path.join(packageRoot, file)));
  const peers = manifest.value.peerDependencies || {};
  if (manifest.value.name !== 'dsh-evolution') {
    addCheck(report, {
      id: 'plugin.package', category: 'plugin', level: LEVEL.BLOCKED,
      summary: `Package name is '${manifest.value.name}', expected 'dsh-evolution'.`,
      evidence: { packageRoot, name: manifest.value.name },
      remediation: 'Install the official dsh-evolution tarball.',
    });
  } else if (missing.length > 0) {
    addCheck(report, {
      id: 'plugin.package', category: 'plugin', level: LEVEL.BLOCKED,
      summary: `${missing.length} required bundle file(s) are missing.`,
      evidence: { packageRoot, missing, version: manifest.value.version },
      remediation: 'Reinstall the bundle tarball; a partial extraction cannot load.',
    });
  } else {
    addCheck(report, {
      id: 'plugin.package', category: 'plugin', level: LEVEL.OK,
      summary: `Bundle package dsh-evolution@${manifest.value.version} is complete.`,
      evidence: { packageRoot, version: manifest.value.version, files: REQUIRED_PACKAGE_FILES.length, engines: manifest.value.engines || null },
    });
  }
  return { version: manifest.value.version, peers };
}

async function diagnosePatch(report, { packageRoot }) {
  const patchPath = path.join(packageRoot, 'cordis.patch.yml');
  const yaml = await loadYaml();
  if (!yaml) {
    addCheck(report, {
      id: 'plugin.patch', category: 'plugin', level: LEVEL.NOT_EVALUATED,
      summary: 'cordis.patch.yml could not be parsed because no YAML parser is reachable from this install.',
      evidence: { patchPath, reason: 'js-yaml is unavailable (expected as a bundle dependency)' },
      remediation: 'Reinstall the bundle so its declared js-yaml dependency is present, then re-run the doctor.',
    });
    return {};
  }
  let entries;
  try {
    entries = yaml.load(fs.readFileSync(patchPath, 'utf8'));
  } catch (error) {
    addCheck(report, {
      id: 'plugin.patch', category: 'plugin', level: LEVEL.BLOCKED,
      summary: 'cordis.patch.yml is unreadable or invalid YAML.',
      evidence: { patchPath, error: String(error.message || error) },
      remediation: 'Reinstall the bundle tarball.',
    });
    return {};
  }
  const inserted = (Array.isArray(entries) ? entries : []).flatMap((entry) => Array.isArray(entry?.insert) ? entry.insert : []);
  const orchestrator = inserted.find((entry) => entry?.id === 'evolution-orchestrator');
  const guard = inserted.find((entry) => entry?.id === 'evolution-trust-root-guard');
  const problems = [];
  for (const [id, name] of Object.entries(REQUIRED_LOADER_ENTRIES)) {
    const entry = inserted.find((item) => item?.id === id);
    if (!entry) problems.push(`${id} loader entry is absent`);
    else if (entry.name !== name) problems.push(`${id} must mount ${name}`);
  }
  if (problems.length > 0) {
    addCheck(report, {
      id: 'plugin.patch', category: 'plugin', level: LEVEL.BLOCKED,
      summary: 'The bundle patch does not declare the expected loader entries.',
      evidence: { patchPath, problems, entries: inserted.map((entry) => entry?.id ?? null), required: Object.keys(REQUIRED_LOADER_ENTRIES) },
      remediation: 'Reinstall the bundle tarball.',
    });
  } else {
    addCheck(report, {
      id: 'plugin.patch', category: 'plugin', level: LEVEL.OK,
      summary: `The bundle patch declares all ${Object.keys(REQUIRED_LOADER_ENTRIES).length} loader entries.`,
      evidence: { patchPath, entries: inserted.map((entry) => entry.id) },
    });
  }
  return { orchestrator, guard };
}

function diagnoseInstalled(report, { profileDir, packageRoot, profileCandidates = [] }) {
  const localVersion = readPeerRange(packageRoot).version;
  if (!profileDir) {
    const known = Array.isArray(profileCandidates) ? profileCandidates : [];
    addCheck(report, {
      id: 'host.install', category: 'host', level: known.length > 0 ? LEVEL.DEGRADED : LEVEL.NOT_EVALUATED,
      summary: known.length > 0
        ? `No profile under $DSH_HOME/profiles lists dsh-evolution (found: ${known.join(', ')}).`
        : 'No DSH profile directory was found, so the installed bundle state is unknown.',
      evidence: known.length > 0
        ? { reason: 'no profile lists dsh-evolution in dsh.profile.bundles', profiles: known }
        : { reason: 'no profile under $DSH_HOME/profiles' },
      remediation: known.length > 0
        ? 'Install it into the profile that should use it: `dsh plugin --profile <name> add <tarball>`. An installed-but-unlisted bundle never loads.'
        : 'Pass --home <DSH_HOME> or --profile <name> so the doctor can read the installed profile.',
      recoverable: false,
    });
    return null;
  }
  const profileManifest = readJsonSafe(path.join(profileDir, 'package.json'));
  if (profileManifest.error) {
    addCheck(report, {
      id: 'host.install', category: 'host', level: LEVEL.BLOCKED,
      summary: 'The profile package.json is unreadable.',
      evidence: { profileDir, error: String(profileManifest.error.message || profileManifest.error) },
      remediation: 'Repair or recreate the profile with `dsh plugin --profile <name> add <tarball>`.',
    });
    return null;
  }
  const bundles = profileManifest.value?.dsh?.profile?.bundles || [];
  const installed = readJsonSafe(path.join(profileDir, 'node_modules', 'dsh-evolution', 'package.json'));
  const installedVersion = installed.value?.version || null;
  const listed = bundles.includes('dsh-evolution');
  if (installed.error && !listed) {
    addCheck(report, {
      id: 'host.install', category: 'host', level: LEVEL.DEGRADED,
      summary: 'The bundle is not installed in this profile.',
      evidence: { profileDir, bundles, installed: false },
      remediation: 'Install it with `dsh plugin --profile <name> add dsh-evolution-<version>.tgz`.',
      recoverable: false,
    });
    return { installedVersion: null, listed };
  }
  if (installed.error) {
    addCheck(report, {
      id: 'host.install', category: 'host', level: LEVEL.BLOCKED,
      summary: 'The profile lists dsh-evolution as a bundle but the package is not installed.',
      evidence: { profileDir, bundles, installed: false },
      remediation: 'Reinstall the tarball; the profile would fail to boot.',
    });
    return { installedVersion: null, listed };
  }
  if (!listed) {
    addCheck(report, {
      id: 'host.install', category: 'host', level: LEVEL.BLOCKED,
      summary: 'dsh-evolution is installed but not listed in dsh.profile.bundles, so it never loads.',
      evidence: { profileDir, installedVersion, bundles },
      remediation: 'Add "dsh-evolution" to the profile bundles (or reinstall through the official CLI).',
    });
    return { installedVersion, listed };
  }
  const mismatch = Boolean(localVersion && installedVersion && localVersion !== installedVersion);
  addCheck(report, {
    id: 'host.install', category: 'host', level: mismatch ? LEVEL.DEGRADED : LEVEL.OK,
    summary: mismatch
      ? `Installed bundle ${installedVersion} differs from this diagnostic build ${localVersion}.`
      : `Profile installs dsh-evolution@${installedVersion} and lists it in the bundle chain.`,
    evidence: { profileDir, installedVersion, localVersion, bundles },
    ...(mismatch ? { remediation: 'Run the doctor from the installed package, or reinstall this build, so the report matches the running code.' } : {}),
  });
  return { installedVersion, listed };
}

/**
 * Multi-profile installed-version consistency. `doctor` normally inspects one
 * profile (`host.install` above only sees that one), but installation is
 * explicitly not an atomic transaction: a setup that stopped partway can leave
 * one profile on an older bundle while the inspected profile looks healthy.
 * This check reads every profile's installed manifest and reports the whole
 * picture without trusting (or mutating) any of them.
 *
 * Only profiles that actually have a readable installed bundle participate in
 * skew detection. A profile without dsh-evolution is `not-installed`, and a
 * profile whose package.json or node_modules cannot be read is `unknown`;
 * neither is counted as a different version.
 */
function diagnoseProfileVersionSkew(report, { dshHome, profileCandidates = [] }) {
  if (!dshHome) return;
  const profilesDir = path.join(dshHome, 'profiles');
  let names;
  try {
    names = fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    // No profiles directory: the single-profile install check already reports
    // the absence, and there is nothing to compare here.
    return;
  }
  for (const name of Array.isArray(profileCandidates) ? profileCandidates : []) {
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  names = [...new Set(names)].sort();
  if (names.length === 0) return;

  const profiles = names.map((name) => {
    const dir = path.join(profilesDir, name);
    const profileManifest = readJsonSafe(path.join(dir, 'package.json'));
    // An unreadable profile manifest makes the whole profile unknown, even if
    // its installed bundle manifest happens to be readable.
    if (profileManifest.error) {
      return { profile: name, installedVersion: null, state: 'unknown', reason: 'profile-manifest-unreadable' };
    }
    const installed = readJsonSafe(path.join(dir, 'node_modules', 'dsh-evolution', 'package.json'));
    const installedVersion = typeof installed.value?.version === 'string' ? installed.value.version : null;
    if (installedVersion) return { profile: name, installedVersion, state: 'installed' };
    if (installed.error && installed.error.code !== 'ENOENT') {
      return { profile: name, installedVersion: null, state: 'unknown', reason: 'installed-manifest-unreadable' };
    }
    // A missing installed manifest means the profile never got the bundle;
    // anything else unreadable is explicitly unknown. Neither is skew.
    if (installed.error || !installed.value) return { profile: name, installedVersion: null, state: 'not-installed' };
    return { profile: name, installedVersion: null, state: 'unknown', reason: 'installed-version-missing' };
  });

  const installedRows = profiles.filter((row) => row.state === 'installed');
  const distinctVersions = [...new Set(installedRows.map((row) => row.installedVersion))].sort();
  const skewed = distinctVersions.length > 1;
  // The reference is the most common installed version (ties broken by profile
  // order), so a single lagging profile is named as unfinished rather than a
  // majority being blamed for the outlier.
  const counts = new Map();
  for (const row of installedRows) counts.set(row.installedVersion, (counts.get(row.installedVersion) || 0) + 1);
  const referenceVersion = [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || installedRows.findIndex((row) => row.installedVersion === left[0]) - installedRows.findIndex((row) => row.installedVersion === right[0]))[0]?.[0] ?? null;
  // A copied remediation must target the home that was diagnosed, not the
  // caller's default DSH_HOME; quote every shell token from the filesystem.
  const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  // The Desktop profile is Electron-managed: the ordinary CLI refuses it, and
  // the same official Desktop CLI path is the one setup-experience uses.
  const desktopCli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  const cliFor = (profile) => profile === 'desktop' ? shellQuote(desktopCli) : 'dsh';
  const remediationByProfile = skewed
    ? installedRows.filter((row) => row.installedVersion !== referenceVersion).map((row) => ({
      profile: row.profile, from: row.installedVersion, to: referenceVersion,
      command: `DSH_HOME=${shellQuote(dshHome)} ${cliFor(row.profile)} plugin --profile ${shellQuote(row.profile)} add ${shellQuote(`./dsh-evolution-${referenceVersion}.tgz`)}`,
    }))
    : [];
  const describe = (rows) => rows.map((row) => `${row.profile}=${row.installedVersion ?? row.state}`).join(', ');

  addCheck(report, {
    id: 'host.profile-version-consistency',
    category: 'host',
    level: skewed ? LEVEL.DEGRADED : LEVEL.OK,
    summary: skewed
      ? `Installed dsh-evolution versions differ across profiles (${describe(profiles)}); ${remediationByProfile.length} profile(s) lag the ${referenceVersion} build.`
      : `All ${installedRows.length} profile(s) with dsh-evolution installed report version ${referenceVersion ?? 'unknown'}; profiles: ${describe(profiles)}; no cross-profile skew.`,
    evidence: {
      dshHome,
      profiles,
      installedVersions: installedRows.map((row) => ({ profile: row.profile, installedVersion: row.installedVersion })),
      distinctVersions,
      skewed,
      referenceVersion,
      ...(skewed ? { remediationByProfile } : {}),
    },
    ...(skewed ? {
      remediation: `Reinstall the lagging profile(s) with the same tarball as the ${referenceVersion} build: ${remediationByProfile.map((row) => `${row.profile}: \`${row.command}\``).join('; ')}.`,
      recoverable: false,
    } : {}),
  });
}

function cliCandidateFailure(candidate) {
  if (candidate.error) return candidate.error;
  if (!candidate.isDsh) return 'TARGET_NOT_DSH';
  if (candidate.versionInvalid) return 'VERSION_INVALID';
  if (!candidate.version) return 'VERSION_UNAVAILABLE';
  if (typeof candidate.version !== 'string' || !parseSemverVersion(candidate.version)) return 'VERSION_INVALID';
  return null;
}

function cliCandidateEvidence(candidate) {
  const error = cliCandidateFailure(candidate);
  return {
    path: candidate.path,
    source: candidate.source,
    ...(candidate.entryPath && candidate.entryPath !== candidate.path ? { entryPath: candidate.entryPath } : {}),
    ...(error ? { error, detail: candidate.unresolvedBranches ? 'one or more launch branches could not be attributed to @deepseek-ai/dsh' : cliResolutionErrorDetail(error) } : {}),
    ...(candidate.unresolvedBranches ? { unresolvedBranches: candidate.unresolvedBranches } : {}),
  };
}

function unresolvedCliSummary(resolution) {
  const branches = resolution.candidates.flatMap((candidate) => {
    if (candidate.unresolvedBranches?.length > 0) return candidate.unresolvedBranches;
    const error = cliCandidateFailure(candidate) || 'UNRESOLVED_EXEC_TARGET';
    return [{ path: candidate.entryPath || candidate.path, error, detail: cliResolutionErrorDetail(error) }];
  });
  return branches.map((branch) => {
    const location = branch.path || (branch.wrapperPath ? `${branch.wrapperPath}:${branch.line ?? '?'}` : '<unknown target>');
    return `${location} (${branch.error}: ${branch.detail})`;
  }).join('; ');
}

function diagnoseHostCli(report, { dshHome, profile, profileDir, cliPath, peers, probe, runningEntry }) {
  const resolution = resolveHostCli({ cliPath, dshHome, profileDir, runningEntry });
  const { selected } = resolution;
  if (!selected) {
    const noCandidate = resolution.candidates.length === 0;
    const reason = noCandidate ? 'no-cli-candidate' : 'cli-candidate-unresolved';
    const candidates = resolution.candidates.map(cliCandidateEvidence);
    const detail = noCandidate
      ? 'No DSH CLI candidate was found on PATH, in the profile, or in the running process.'
      : `DSH CLI candidate(s) exist, but a single DSH host could not be attributed because at least one launch branch is unresolved: ${unresolvedCliSummary(resolution)}.`;
    const remediation = noCandidate
      ? 'Pass --dsh-cli <path/to/@deepseek-ai/dsh/lib/bin.js> or make `dsh` available on PATH.'
      : 'Pass --dsh-cli <path/to/@deepseek-ai/dsh/lib/bin.js> for the exact host used by this profile, or repair the named wrapper branch(es) so every launch target can be attributed statically. The existing CLI candidate(s) must not be silently replaced by another installation.';
    const evidence = { reason, candidates };
    addCheck(report, {
      id: 'host.cli', category: 'host', level: LEVEL.NOT_EVALUATED,
      summary: `${detail} Host version and composed profile could not be verified.`,
      evidence,
      remediation,
    });
    for (const [id, subject] of [
      ['host.version', 'Host version'],
      ['host.modules', 'Host modules'],
      ['host.composition', 'The composed loader tree'],
    ]) {
      addCheck(report, {
        id, category: 'host', level: LEVEL.NOT_EVALUATED,
        summary: `${subject} could not be evaluated because no DSH CLI host was attributable. ${detail}`,
        evidence,
        remediation,
      });
    }
    return { selected: null, version: null, resolution };
  }
  const supported = peers?.['@deepseek-ai/dsh'] || null;
  const conflictingHosts = resolution.alternatives.filter((candidate) => candidate.path === selected.path);
  const candidateVersionLabels = [...new Set([selected, ...conflictingHosts]
    .map(cliVersionIdentity)
    .filter((value) => value !== null && value !== undefined)
    .map(cliVersionLabel))].sort();
  // A wrapper may route --profile to different installations. The static
  // resolver exposes every exec target, but branch order/version does not prove
  // which one boots the requested profile. Keep the winner as a composition
  // launch candidate, never as the profile's host identity.
  const profileHostAmbiguous = conflictingHosts.length > 0;
  const attributedVersion = profileHostAmbiguous ? null : selected.version;
  const satisfies = Boolean(attributedVersion && supported && satisfiesRange(attributedVersion, supported));
  const verified = Boolean(attributedVersion && SUPPORTED_DSH_VERSIONS.includes(attributedVersion));
  // The documented contract is exact declared versions only: a version string
  // that merely satisfies the range (build metadata, a `v` prefix) is not a
  // release this bundle's host-surface contract was verified against, so the
  // verdict follows `verified` and the evidence keeps both facts.
  const versionOk = satisfies && verified;
  let hostModules;
  let blockingProblems;
  let advisoryProblems;
  let modulesCheck;
  if (profileHostAmbiguous) {
    hostModules = [];
    blockingProblems = [];
    advisoryProblems = [];
    modulesCheck = {
      id: 'host.modules', category: 'host', level: LEVEL.NOT_EVALUATED,
      summary: 'Host modules cannot be attributed because the CLI resolves to multiple DSH versions.',
      evidence: {
        reason: 'profile-host-ambiguous', profile: profile ?? null,
        candidateVersions: candidateVersionLabels,
      },
      remediation: 'Pass --dsh-cli <path/to/@deepseek-ai/dsh/lib/bin.js> for the exact host used by this profile, not a multi-target wrapper.',
    };
  } else if (!selected.packageRoot) {
    // A packaged Desktop host boots from app.asar; plain Node cannot resolve
    // packages from inside it. Report the gap instead of crashing on
    // path.join(null, ...) or pretending the bundle's peer copy is the host.
    hostModules = HOST_MODULES.map((module) => ({
      name: module.name, kind: module.kind, blocking: module.blocking,
      version: null, resolved: false, error: 'PACKAGE_ROOT_UNAVAILABLE',
      supported: peers?.[module.name] || null, satisfies: null,
    }));
    blockingProblems = [];
    advisoryProblems = [];
    modulesCheck = {
      id: 'host.modules', category: 'host', level: LEVEL.NOT_EVALUATED,
      summary: 'Host modules could not be resolved because this CLI has no Node-resolvable package root.',
      evidence: { reason: 'host-package-root-unavailable', packageRoot: null, hostFacts: selected.hostFacts || null, modules: hostModules },
      remediation: 'Pass --dsh-cli <path/to/@deepseek-ai/dsh/lib/bin.js> to inspect a Node-resolvable host package.',
    };
  } else {
    hostModules = HOST_MODULES.map((module) => {
      const found = resolveFrom(path.join(selected.packageRoot, 'package.json'), `${module.name}/package.json`);
      const peerRange = peers?.[module.name];
      // A package at the official path is not the official package unless its
      // manifest agrees. This is the same fail-closed rule the runtime applies
      // when it reads a version; without it doctor can call a foreign package's
      // version a compatible official dependency.
      const nameMismatch = found.resolved && found.name !== module.name;
      return {
        name: module.name, kind: module.kind, blocking: module.blocking,
        version: nameMismatch ? null : found.version || null,
        resolved: Boolean(found.resolved) && !nameMismatch,
        error: nameMismatch ? 'PACKAGE_NAME_MISMATCH' : found.error || null,
        supported: peerRange || null,
        satisfies: !nameMismatch && found.version && peerRange ? satisfiesRange(found.version, peerRange) : null,
      };
    });
    blockingProblems = hostModules.filter((module) => module.blocking && (!module.resolved || module.satisfies === false));
    advisoryProblems = hostModules.filter((module) => !module.blocking && (!module.resolved || module.satisfies === false));
    modulesCheck = {
      id: 'host.modules', category: 'host', level: blockingProblems.length > 0 ? LEVEL.BLOCKED : advisoryProblems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
      summary: blockingProblems.length > 0
        ? `${blockingProblems.length} required host module(s) missing or out of range.`
        : advisoryProblems.length > 0
          ? `${advisoryProblems.length} optional host module(s) unavailable; a degraded capability is expected.`
          : 'Every required and optional host module resolved inside the supported range.',
      evidence: { modules: hostModules, blockingProblems: blockingProblems.map((module) => module.name), advisoryProblems: advisoryProblems.map((module) => module.name) },
      remediation: blockingProblems.length > 0 ? 'Reinstall the matching DSH release; the bundle imports these modules directly.' : undefined,
      recoverable: false,
    };
  }

  addCheck(report, {
    id: 'host.cli', category: 'host', level: LEVEL.OK,
    summary: profileHostAmbiguous
      ? `Resolved multiple DSH CLI candidates (${candidateVersionLabels.join(', ')}); none is attributed to profile ${profile ?? '<unknown>'} without an exact --dsh-cli.`
      : `Resolved DSH CLI (${selected.source}) with @deepseek-ai/dsh@${selected.version || 'unknown'}.`,
    evidence: {
      source: selected.source, cli: selected.path, realPath: selected.realPath, packageRoot: selected.packageRoot,
      candidates: resolution.candidates.map((candidate) => ({ path: candidate.path, source: candidate.source, isDsh: candidate.isDsh, version: candidate.version })),
      conflictingHosts: conflictingHosts.map((candidate) => ({ source: candidate.source, version: candidate.version })),
      ...(profileHostAmbiguous ? { profileHostAmbiguous: true, profileHost: null } : {}),
    },
    ...(profileHostAmbiguous
      ? { remediation: 'This CLI routes to more than one DSH version. Pass --dsh-cli pointing to the exact @deepseek-ai/dsh/lib/bin.js used by the diagnosed profile (not the multi-target wrapper), or provide a profile-specific running host, so one candidate is not silently treated as the profile host.' }
      : resolution.alternatives.some((candidate) => candidate.version && candidate.version !== selected.version)
        ? { remediation: 'Another DSH installation on this machine has a different version; pass --dsh-cli to state which host this report should describe.' }
        : {}),
  });
  addCheck(report, {
    id: 'host.version', category: 'host', level: profileHostAmbiguous ? LEVEL.NOT_EVALUATED : versionOk ? LEVEL.OK : LEVEL.BLOCKED,
    summary: profileHostAmbiguous
      ? `The CLI exposes multiple DSH versions, so the host version for profile ${profile ?? '<unknown>'} cannot be proven.`
      : versionOk
        ? `Host version ${attributedVersion} satisfies the supported range ${supported}, and is one of the host versions verified by a real install acceptance run (${SUPPORTED_DSH_VERSIONS.join(', ')}).`
        : satisfies
          ? `Host version ${attributedVersion} satisfies the supported range ${supported}, but it is not one of the versions verified by a real install acceptance run (${SUPPORTED_DSH_VERSIONS.join(', ')}).`
          : `Host version ${attributedVersion ?? 'unknown'} does not satisfy the supported range ${supported ?? 'unknown'}.`,
    evidence: {
      found: attributedVersion, supported, verified, verifiedHosts: SUPPORTED_DSH_VERSIONS, cli: selected.path,
      ...(profileHostAmbiguous ? { reason: 'profile-host-ambiguous' } : {}),
    },
    remediation: profileHostAmbiguous
      ? 'Pass --dsh-cli pointing to the exact host entry used by this profile; the multi-version wrapper does not prove which DSH version boots it.'
      : versionOk ? undefined : `Install a verified DSH (${SUPPORTED_DSH_VERSIONS.join(' or ')}) before enabling this bundle: the host-surface contract recorded in lib/cordis-compat.js is only verified for those releases, and the doctor reports an unverified host as blocked instead of guessing that it is compatible.`,
    recoverable: false,
  });
  addCheck(report, modulesCheck);

  const composition = diagnoseComposition({ report, dshHome, profile, profileDir, selected, probe });
  return { selected, version: attributedVersion, hostModules, composition, profileHostAmbiguous, conflictingHosts };
}

function diagnoseComposition({ report, dshHome, profile, profileDir, selected, probe }) {
  if (probe?.skipComposition === true) {
    addCheck(report, {
      id: 'host.composition', category: 'host', level: LEVEL.NOT_EVALUATED,
      summary: 'The composed loader tree was not dumped because the composition probe was disabled.',
      evidence: { reason: 'composition probe disabled (--no-composition)' },
      remediation: 'Re-run without --no-composition to verify the loader entries against the official CLI.',
    });
    return null;
  }
  if (!profile || !dshHome) {
    addCheck(report, {
      id: 'host.composition', category: 'host', level: LEVEL.NOT_EVALUATED,
      summary: 'No profile name was resolved, so the composed loader tree was not dumped.',
      evidence: { reason: 'DSH_HOME or profile name unknown' },
      remediation: 'Pass --home <DSH_HOME> and --profile <name>.',
    });
    return null;
  }
  let isolatedHome = null;
  if (!probe?.runDumpConfig) {
    // The profile name is a path component inside the throwaway home. Reject
    // anything that could escape it before copying or running the CLI.
    if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) || profile === '.' || profile === '..') {
      addCheck(report, {
        id: 'host.composition', category: 'host', level: LEVEL.NOT_EVALUATED,
        summary: 'The composed loader tree was not dumped because the profile name cannot be isolated safely.',
        evidence: { reason: 'profile name is not a safe path component', profile: profile ?? null },
        remediation: 'Use a profile name matching [A-Za-z0-9][A-Za-z0-9._-]* and re-run the doctor.',
      });
      return null;
    }
    // Only a fully initialized profile can be composed; the doctor must not
    // create the missing pieces just to run a probe.
    const profileReady = Boolean(profileDir)
      && ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']
        .every((name) => Boolean(statFollowSafe(path.join(profileDir, name))?.isFile()))
      && Boolean(statFollowSafe(path.join(profileDir, 'node_modules'))?.isDirectory());
    if (!profileReady) {
      addCheck(report, {
        id: 'host.composition', category: 'host', level: LEVEL.NOT_EVALUATED,
        summary: 'The composed loader tree was not dumped because the profile is not fully initialized.',
        evidence: { reason: 'profile is incomplete; doctor will not initialize it', profile, profileDir: profileDir ?? null },
        remediation: 'Start this profile once with the official CLI, then re-run the doctor.',
      });
      return null;
    }
    // The real CLI is not read-only: --dump-config rewrites cordis.yml. Probe a
    // copy under a throwaway DSH_HOME so the user's files and mtimes stay
    // untouched. Symlinks are dereferenced so a config link cannot write
    // through to its source; node_modules is linked separately. A home-level
    // cordis.patch.yml must also be present for the CLI's patch resolution.
    try {
      isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-doctor-'));
      const copyDir = path.join(isolatedHome, 'profiles', profile);
      // Defense in depth: the resolved copy target must stay below the
      // throwaway home even if a future caller bypasses the name check.
      const isolatedRoot = path.resolve(isolatedHome);
      if (!path.resolve(copyDir).startsWith(`${isolatedRoot}${path.sep}`)) {
        throw new Error('profile copy escaped the throwaway DSH_HOME');
      }
      fs.mkdirSync(path.dirname(copyDir), { recursive: true });
      fs.cpSync(profileDir, copyDir, {
        recursive: true,
        dereference: true,
        filter: (source) => path.relative(profileDir, source).split(path.sep)[0] !== 'node_modules',
      });
      const modules = path.join(profileDir, 'node_modules');
      if (statFollowSafe(modules)?.isDirectory()) fs.symlinkSync(modules, path.join(copyDir, 'node_modules'), 'dir');
      const homePatch = path.join(dshHome, 'cordis.patch.yml');
      if (statFollowSafe(homePatch)?.isFile()) fs.copyFileSync(homePatch, path.join(isolatedHome, 'cordis.patch.yml'));
    } catch {
      if (isolatedHome) { try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ } }
      isolatedHome = null;
      addCheck(report, {
        id: 'host.composition', category: 'host', level: LEVEL.NOT_EVALUATED,
        summary: 'The composed loader tree was not dumped because it could not be isolated from the real profile.',
        evidence: { reason: 'cannot isolate profile for a read-only probe', profile, profileDir: profileDir ?? null },
        remediation: 'Re-run with a readable profile directory, or pass a hermetic dump-config probe.',
      });
      return null;
    }
  }
  const run = probe?.runDumpConfig || defaultRunDumpConfig;
  let outcome;
  try {
    outcome = run({ cliPath: selected.path, dshHome: isolatedHome || dshHome, profile });
  } finally {
    if (isolatedHome) { try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  if (outcome.status !== 0) {
    addCheck(report, {
      id: 'host.composition', category: 'host', level: LEVEL.BLOCKED,
      summary: 'The official CLI could not compose this profile.',
      evidence: {
        profile, exitCode: outcome.status, error: outcome.error,
        stderr: String(outcome.stderr || '').split('\n').filter(Boolean).slice(-8),
      },
      remediation: 'Fix the profile error above first; the bundle cannot be verified while the profile does not boot.',
      recoverable: false,
    });
    return null;
  }
  const composed = parseComposedProfile(outcome.stdout);
  const section = composed.sections.get('dsh-evolution');
  const problems = [];
  if (!section) {
    problems.push('the composed profile has no dsh-evolution layer');
    addCheck(report, {
      id: 'host.composition', category: 'host', level: LEVEL.BLOCKED,
      summary: 'The composed profile does not contain a dsh-evolution layer.',
      evidence: { profile, sections: composed.titles.slice(-8), problems },
      remediation: 'Add "dsh-evolution" to the profile bundles and restart.',
      recoverable: false,
    });
    return null;
  }
  const writer = composedEventBridgeWriter(composed);
  const orchestratorEntry = section.entries.find((entry) => entry.id === 'evolution-orchestrator');
  const guardEntry = section.entries.find((entry) => entry.id === 'evolution-trust-root-guard');
  const consumerEntry = section.entries.find((entry) => entry.id === 'evolution-promoted-consumer');
  const experienceEntry = section.entries.find((entry) => entry.id === 'evolution-experience');
  const isDisabled = (entry) => Boolean(entry && entry.disabled !== null && !/^false$/.test(entry.disabled));
  // A standard multi-profile install disables the kernel in the ACP/Web
  // profiles and mounts the promoted-plugin consumer there instead. Requiring
  // the kernel in every profile reports a healthy install as blocked (and
  // `doctor` without --profile picks the alphabetically first profile, acp).
  // The consumer role is only valid on a profile the plugin actually serves:
  // a desktop/custom profile that disables the kernel has no working consumer.
  const consumerRole = SHARED_CONSUMER_PROFILES.includes(profile) && Boolean(orchestratorEntry && isDisabled(orchestratorEntry));
  if (!orchestratorEntry) problems.push('evolution-orchestrator entry is absent');
  else {
    if (orchestratorEntry.name !== 'dsh-evolution') problems.push(`evolution-orchestrator mounts ${orchestratorEntry.name}`);
    if (!consumerRole && isDisabled(orchestratorEntry)) problems.push('evolution-orchestrator is disabled');
  }
  // Every profile needs the experience provider: it supplies the required
  // `evolutionExperience` service even on a consumer-only profile.
  if (!experienceEntry) problems.push('evolution-experience entry is absent');
  else {
    if (isDisabled(experienceEntry)) problems.push('evolution-experience is disabled');
    if (experienceEntry.name !== REQUIRED_LOADER_ENTRIES['evolution-experience']) problems.push(`evolution-experience mounts ${experienceEntry.name}`);
  }
  if (consumerRole) {
    if (!consumerEntry) problems.push('evolution-promoted-consumer entry is absent');
    else {
      if (isDisabled(consumerEntry)) problems.push('evolution-promoted-consumer is disabled');
      if (consumerEntry.name !== REQUIRED_LOADER_ENTRIES['evolution-promoted-consumer']) problems.push(`evolution-promoted-consumer mounts ${consumerEntry.name}`);
    }
  }
  if (!guardEntry) problems.push('evolution-trust-root-guard entry is absent');
  else {
    if (isDisabled(guardEntry)) problems.push('evolution-trust-root-guard is disabled');
    if (guardEntry.name !== REQUIRED_LOADER_ENTRIES['evolution-trust-root-guard']) problems.push(`evolution-trust-root-guard mounts ${guardEntry.name}`);
  }
  const level = problems.length > 0 ? LEVEL.BLOCKED : LEVEL.OK;
  const role = consumerRole ? 'promoted-consumer' : 'evolution-kernel';
  addCheck(report, {
    id: 'host.composition', category: 'host', level,
    summary: problems.length > 0
      ? `The composed profile is missing ${problems.length} required bundle entry/entries.`
      : `The composed ${role} profile contains the required bundle entries in the enabled state.`,
    evidence: { profile, role, entries: section.entries, problems, sectionTitles: section.rawTitles, patched: section.patched, eventBridgeWriter: writer },
    remediation: problems.length > 0 ? 'Reinstall the bundle or re-enable it through the official plugin manager, then restart.' : undefined,
    recoverable: false,
  });
  return { entries: section.entries, problems, writer, patched: section.patched, rawTitles: section.rawTitles };
}

// ---------------------------------------------------------------------------
// crash residue the runtime owns but cannot always clear: target claims and the
// event-bridge key
// ---------------------------------------------------------------------------

/** A target claim file name: the sha256 of the target, as `acquireTargets()` writes it. */
const CLAIM_FILE = /^[0-9a-f]{64}\.json$/;
/**
 * A grace period for an unreadable claim, chosen to match the archive lock's
 * settle window (lib/domain-storage.js `LOCK_SETTLE_MS`). It is a doctor-side
 * reporting rule, not a runtime rule: the claim protocol has no settle window
 * and the runtime never reclaims an unreadable claim, which is exactly why no
 * repair is offered and why only the level depends on this window.
 */
const OWNERSHIP_SETTLE_MS = 1000;

/** The bare fields a claim can contribute to a report. The raw document is never
 * reproduced (it may hold anything) and every string is bounded. */
function claimFields(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return null;
  const bounded = (value) => (typeof value === 'string' ? value.slice(0, 160) : null);
  return {
    target: bounded(claim.target),
    experimentId: bounded(claim.experimentId),
    hostname: bounded(claim.hostname),
    pid: Number.isInteger(claim.pid) ? claim.pid : null,
    acquiredAt: bounded(claim.acquiredAt),
  };
}

/** What a resolved path points at, for reports that must explain why they did not
 *  open it. `isFile()` is the only shape either reader is allowed to read. */
function describeFileKind(stat) {
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isCharacterDevice()) return 'character device';
  if (stat.isBlockDevice()) return 'block device';
  if (stat.isDirectory()) return 'directory';
  return 'non-regular entry';
}

/**
 * Inspect every claim in the ownership directory. The classification is the
 * runtime's own `parseTargetClaim` + `classifyTargetClaim` pair, applied in the
 * same order the acquisition uses, so a claim the runtime would reclaim, adopt
 * or refuse is reported as exactly that (AGENTS.md §4 第 11 条：同一路径只有
 * 一套协议，由运行时与 doctor 共用)。
 *
 * `kind` says what the directory itself is. Only a real directory is enumerated:
 * a symlink at the ownership path is reported as such and **not followed**, even
 * though the runtime's `mkdirSync` and claim reads follow it, because the doctor
 * cannot prove which claim files that link resolves to.
 */
function inspectOwnershipClaims(paths) {
  let dir;
  try { dir = fs.lstatSync(paths.ownershipDir); }
  catch (error) {
    if (error?.code !== 'ENOENT') return { kind: 'uninspectable', present: true, readError: error?.code || 'STAT_FAILED', linkTarget: null, entryKind: null, claims: [] };
    return { kind: 'absent', present: false, readError: null, linkTarget: null, entryKind: null, claims: [] };
  }
  if (dir.isSymbolicLink()) {
    let linkTarget = null;
    try { linkTarget = fs.readlinkSync(paths.ownershipDir); } catch { /* the target is not readable */ }
    return { kind: 'symlink', present: true, readError: null, linkTarget, entryKind: null, claims: [] };
  }
  if (!dir.isDirectory()) {
    return { kind: 'other', present: true, readError: null, linkTarget: null, entryKind: dir.isFile() ? 'file' : 'other', claims: [] };
  }
  const listed = (() => {
    try { return fs.readdirSync(paths.ownershipDir).filter((name) => CLAIM_FILE.test(name)).sort(); }
    catch (error) { return { error: error?.code || 'READDIR_FAILED' }; }
  })();
  // A directory that can be stat'ed but not listed leaves the doctor unable to
  // prove which claims the runtime would see; it must say so, not claim there
  // are none.
  if (!Array.isArray(listed)) {
    return { kind: 'uninspectable', present: true, readError: listed.error, linkTarget: null, entryKind: null, claims: [] };
  }
  const claims = listed.flatMap((name) => {
    const file = path.join(paths.ownershipDir, name);
    let entry;
    try { entry = fs.lstatSync(file); }
    catch (error) {
      if (error?.code === 'ENOENT') return [];
      // The entry is listed but cannot be inspected: report it as unreadable
      // rather than silently dropping it from the report.
      return [{ file, name, state: TARGET_CLAIM_STATES.UNREADABLE, bytes: null, regularFile: false, symlink: false, ageMs: null, readError: error?.code || 'STAT_FAILED', claim: null }];
    }
    // Resolve the entry the way readFileSync would (following a symlink) and
    // never open anything that is not a regular file: a FIFO or a socket here
    // would block the doctor indefinitely. A symlink to a regular file is still
    // accepted, because the runtime's readFileSync follows it.
    const ageMs = Math.max(0, Date.now() - entry.mtimeMs);
    let target;
    try { target = fs.statSync(file); }
    catch (error) {
      return [{ file, name, state: TARGET_CLAIM_STATES.UNREADABLE, bytes: null, regularFile: false, symlink: entry.isSymbolicLink(), ageMs, targetKind: entry.isSymbolicLink() ? 'dangling symlink' : 'unresolvable entry', statError: error?.code || 'STAT_FAILED', claim: null }];
    }
    if (!target.isFile()) {
      return [{ file, name, state: TARGET_CLAIM_STATES.UNREADABLE, bytes: target.size, regularFile: false, symlink: entry.isSymbolicLink(), ageMs, targetKind: describeFileKind(target), claim: null }];
    }
    let text = null;
    let readError = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { readError = error?.code || 'READ_FAILED'; }
    const parsed = text === null ? null : parseTargetClaim(text);
    const classified = parsed === null ? { state: TARGET_CLAIM_STATES.UNREADABLE, claim: null } : classifyTargetClaim(parsed);
    return [{
      file,
      name,
      state: classified.state,
      bytes: target.size,
      regularFile: true,
      symlink: entry.isSymbolicLink(),
      ageMs,
      ...(readError ? { readError } : {}),
      claim: claimFields(classified.claim),
    }];
  });
  return { kind: 'directory', present: true, readError: null, linkTarget: null, entryKind: null, claims };
}

/** Whether a claim blocks the runtime for good: unreadable bytes, a foreign host,
 *  or a document that carries no usable owner. */
function isBlockingClaim(claim) {
  return claim.state === TARGET_CLAIM_STATES.UNREADABLE
    || claim.state === TARGET_CLAIM_STATES.FOREIGN_HOST
    || claim.state === TARGET_CLAIM_STATES.INCOMPLETE;
}

function describeClaim(claim) {
  const fields = claim.claim || {};
  const target = fields.target ? `target ${fields.target}` : 'target unknown';
  const experiment = fields.experimentId ? `experiment ${fields.experimentId}` : 'experiment unknown';
  const age = claim.ageMs === null ? 'age unknown' : `${Math.round(claim.ageMs)} ms old`;
  if (claim.state === TARGET_CLAIM_STATES.UNREADABLE) {
    const shape = claim.targetKind
      ? `not a regular file (${claim.targetKind})`
      : claim.readError ? `unreadable (${claim.readError})` : claim.bytes === 0 ? '0 bytes' : `${claim.bytes} bytes, not JSON`;
    return `${claim.name} (unreadable: ${shape}; ${target}; ${age})`;
  }
  if (claim.state === TARGET_CLAIM_STATES.FOREIGN_HOST) {
    return `${claim.name} (foreign host ${fields.hostname}; ${target}; pid ${fields.pid}; ${experiment}; ${age})`;
  }
  const missing = [];
  if (!fields.hostname) missing.push('hostname');
  if (!Number.isInteger(fields.pid)) missing.push('integer pid');
  return `${claim.name} (incomplete: no usable ${missing.join(' and ')}; ${target}; ${experiment}; ${age})`;
}

/**
 * Report every target claim on disk. Report-only: the doctor never removes a
 * claim, and no repair id exists for one.
 *
 * A claim file is the only rendezvous point between acquisition attempts and,
 * unlike the archive lock, it carries no identity the creating call can
 * re-prove: `acquireArchiveLock` pins the inode it opened with `fstat` and
 * re-checks it before every guarded write, while a claim is a plain `wx` create
 * whose writer never re-proves anything. A zero-byte entry therefore cannot be
 * told apart from an acquisition suspended between its exclusive open and its
 * write; a settle window cannot supply that proof, because the writer resumes
 * whenever it is scheduled. Removing the entry would let a second experiment
 * acquire the target and let the first one continue into a Trial believing it
 * still owns it. Every shape is reported with the manual instruction it needs.
 */
function diagnoseOwnership(report, paths) {
  const inspection = inspectOwnershipClaims(paths);
  // The path is not a claim directory. The runtime follows a symlink (mkdirSync,
  // every claim read and write), so enumerating through it would make the doctor
  // interpret a path its own invariants treat as a defect - and saying "no claim"
  // about a path it did not look at would be worse. Reported, never followed.
  if (inspection.kind !== 'directory' && inspection.kind !== 'absent') {
    const what = inspection.kind === 'symlink'
      ? `a symlink${inspection.linkTarget ? ` to ${inspection.linkTarget}` : ' whose target could not be read'}`
      : inspection.kind === 'other'
        ? `a ${inspection.entryKind || 'non-directory'} entry`
        : `unreadable (${inspection.readError})`;
    addCheck(report, {
      id: 'state.ownership', category: 'state', level: LEVEL.BLOCKED,
      summary: `The target ownership directory is ${what}; the runtime follows it for its claims, so the doctor cannot prove which claim files it would see and does not enumerate them.`,
      evidence: {
        ownershipDir: paths.ownershipDir,
        kind: inspection.kind,
        linkTarget: inspection.linkTarget,
        readError: inspection.readError,
        claims: [],
        repairPolicy: 'none: the doctor never removes or rewrites a target claim',
      },
      remediation: `Replace the entry at ${paths.ownershipDir} with a real directory (or move it aside) after establishing that no process on any host runs an experiment for a target recorded inside it; the doctor does not follow a link to enumerate claims.`,
      recoverable: false,
    });
    return;
  }
  const claims = inspection.claims;
  // `reclaimable` is the runtime's pre-existing automatic rule, not a doctor
  // decision: same hostname, an integer pid, and only `process.kill(pid, 0)`
  // raising ESRCH. `classifyTargetClaim` owns it and the acquisition acts on it;
  // this check only reports that classification. A pid reused by an unrelated
  // process looks live to the rule, which is why a `live` claim never blocks.
  const reclaimable = claims.filter((claim) => claim.state === TARGET_CLAIM_STATES.RECLAIMABLE);
  const live = claims.filter((claim) => claim.state === TARGET_CLAIM_STATES.LIVE);
  // A byte-less entry younger than the settle window can be an acquisition in
  // progress, so it is never blocked on that evidence alone. An entry whose age
  // could not be established has no grace.
  const inProgress = claims.filter((claim) => claim.state === TARGET_CLAIM_STATES.UNREADABLE && claim.regularFile === true && claim.ageMs !== null && claim.ageMs < OWNERSHIP_SETTLE_MS);
  const blocking = claims.filter((claim) => isBlockingClaim(claim) && !inProgress.includes(claim));
  let level = LEVEL.OK;
  let summary;
  if (blocking.length > 0) {
    level = LEVEL.BLOCKED;
    summary = `${blocking.length} target claim file(s) cannot be cleared by the runtime: ${blocking.map(describeClaim).join('; ')}.`;
  } else if (claims.length === 0) {
    summary = inspection.kind === 'directory'
      ? 'No target ownership claims exist; no experiment is holding a target.'
      : 'No target ownership directory exists yet; no experiment is holding a target.';
  } else {
    level = LEVEL.DEGRADED;
    const advisory = [];
    if (inProgress.length > 0) {
      advisory.push(`${inProgress.length} claim file(s) are unreadable but younger than the ${OWNERSHIP_SETTLE_MS} ms settle window (${inProgress.map(describeClaim).join('; ')}): an acquisition may be in progress, so re-run the doctor before treating them as abandoned`);
    }
    if (live.length > 0) {
      advisory.push(`${live.length} claim(s) name a process that is still running (${live.map(describeClaim).join('; ')}): an in-flight Trial legitimately holds a claim while the app runs, and a pid reused by an unrelated process is indistinguishable from it`);
    }
    if (reclaimable.length > 0) {
      advisory.push(`${reclaimable.length} claim(s) name a process that is no longer running; the runtime's pre-existing rule reclaims a same-host claim whose integer pid it can prove gone with ESRCH, so the next acquisition of that target on this host reclaims them (${reclaimable.map(describeClaim).join('; ')})`);
    }
    summary = `${advisory.join('; ')}.`;
  }
  const remediation = [];
  if (blocking.length > 0) {
    remediation.push(`Before removing any of ${blocking.map((claim) => claim.name).join(', ')} by hand, establish that no process on any host runs an experiment for the target it records: the runtime only reclaims a claim whose owner it can prove gone, so an unreadable, foreign-host or incomplete claim is unknown state, not proof that the target is free.`);
  }
  if (inProgress.length > 0) {
    remediation.push(`Re-run the doctor once ${inProgress.map((claim) => claim.name).join(', ')} is older than the settle window; if it is still unreadable then, establish that no process on any host runs an experiment for its target before removing it by hand.`);
  }
  if (live.length > 0) {
    remediation.push(`If this plugin is not running an experiment for ${live.map((claim) => claim.name).join(', ')}, the recorded pid was reused by an unrelated process; establish that no process on any host runs an experiment for those targets before removing the claim files by hand.`);
  }
  addCheck(report, {
    id: 'state.ownership', category: 'state', level,
    summary,
    evidence: {
      ownershipDir: paths.ownershipDir,
      kind: inspection.kind,
      directoryPresent: inspection.present,
      claims,
      states: claims.reduce((counts, claim) => ({ ...counts, [claim.state]: (counts[claim.state] || 0) + 1 }), {}),
      inProgressClaims: inProgress.map((claim) => claim.name),
      reclaimableClaims: reclaimable.map((claim) => claim.name),
      liveClaims: live.map((claim) => claim.name),
      blockingClaims: blocking.map((claim) => claim.name),
      repairPolicy: 'none: the doctor never removes or rewrites a target claim',
    },
    ...(remediation.length > 0 ? { remediation: remediation.join(' ') } : {}),
    ...(level === LEVEL.OK ? {} : { recoverable: level === LEVEL.DEGRADED }),
  });
}

/**
 * Read the event-bridge key exactly the way `storageConfig()` (lib/index.js)
 * does - the trimmed file content, valid only as 64 lowercase hex characters -
 * and classify it as precisely one of the four states a reader can distinguish.
 * Nothing here writes.
 */
function readEventBridgeKey(paths) {
  let entry;
  try { entry = fs.lstatSync(paths.keyPath); }
  catch (error) {
    // Only ENOENT proves absence; a failed stat leaves the state unproven.
    if (error?.code === 'ENOENT') return { state: 'absent', text: null, present: false, bytes: 0, mode: null, regularFile: false };
    return { state: 'malformed', text: null, present: true, bytes: null, mode: null, regularFile: false, readError: error?.code || 'STAT_FAILED' };
  }
  const base = { present: true, mode: (entry.mode & 0o777).toString(8), symlink: entry.isSymbolicLink() };
  // Resolve the entry the way readFileSync would (following a symlink) and never
  // open anything that is not a regular file: a FIFO or a socket at this path
  // would block the doctor indefinitely. A symlink to a regular file stays
  // acceptable, because the runtime's readFileSync follows it.
  let target;
  try { target = fs.statSync(paths.keyPath); }
  catch (error) {
    return { ...base, state: 'malformed', text: null, bytes: null, regularFile: false, targetKind: entry.isSymbolicLink() ? 'dangling symlink' : 'unresolvable entry', statError: error?.code || 'STAT_FAILED' };
  }
  if (!target.isFile()) {
    return { ...base, state: 'malformed', text: null, bytes: target.size, regularFile: false, targetKind: describeFileKind(target) };
  }
  const withTarget = { ...base, bytes: target.size, regularFile: true };
  let text;
  try { text = fs.readFileSync(paths.keyPath, 'utf8').trim(); }
  catch (error) { return { ...withTarget, state: 'malformed', text: null, readError: error?.code || 'READ_FAILED' }; }
  if (target.size === 0) return { ...withTarget, state: 'empty', text: '' };
  return { ...withTarget, state: HEX64.test(text) ? 'valid' : 'malformed', text };
}

function countRecordKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).length;
}

function countFileRecords(file) {
  try {
    let records = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim() !== '') records += 1;
    return records;
  } catch { return null; }
}

const ARTIFACT_ABSENT = 'absent';
const ARTIFACT_EMPTY = 'empty';
const ARTIFACT_MAC_BEARING = 'mac-bearing';
const ARTIFACT_UNKNOWN = 'unknown';

/**
 * Classify one path by what this doctor can actually establish.
 *
 * `lstat` proves absence only through `ENOENT`; `EACCES`, `EIO` and every other
 * failure leave the state unknown. A symlink or a directory at the path is
 * unknown too, never "empty": the doctor cannot read the bytes it would be
 * claiming do not exist.
 */
function classifyArtifactPath(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return { state: ARTIFACT_ABSENT, bytes: 0 };
    return { state: ARTIFACT_UNKNOWN, bytes: null, readError: error?.code || 'STAT_FAILED' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { state: ARTIFACT_UNKNOWN, bytes: stat.size, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other' };
  }
  if (stat.size === 0) return { state: ARTIFACT_EMPTY, bytes: 0 };
  return { state: ARTIFACT_MAC_BEARING, bytes: stat.size };
}

/** Checkpoint temporaries: `writeEventLogCheckpoint()` writes the whole document
 *  to `<checkpoint>.<hex>.tmp` before the rename, so a temporary can hold the
 *  same MAC bytes as the checkpoint itself. A directory that can be read by
 *  exact path but not listed is reported as a failure, never as "no temporary":
 *  an empty list would let the artifact look absent or empty when it is not
 *  provably either. */
function checkpointTemporaries(dataRoot, checkpointName) {
  try {
    return {
      names: fs.readdirSync(dataRoot)
        .filter((name) => name.startsWith(`${checkpointName}.`) && name.endsWith('.tmp'))
        .sort(),
      error: null,
    };
  } catch (error) {
    // A data root that does not exist yet is a fresh install, not an unproven
    // one: ENOENT proves there is no directory to hold a temporary. Every other
    // failure leaves the artifact unknown, because a temporary this doctor could
    // not list would otherwise be reported as absent.
    if (error?.code === 'ENOENT') return { names: [], error: null };
    return { names: null, error: error?.code || 'READDIR_FAILED' };
  }
}

/**
 * What the doctor can establish about the artifacts a key would sign.
 *
 * Exactly three named artifacts carry bytes signed with the bridge key: the
 * event bridge envelopes (`execution-events.jsonl`), the domain `applied` marker
 * maps (committed and pending), and the replay checkpoint - plus any checkpoint
 * temporary, which is written before the atomic rename and can carry the same
 * MAC. Failure memory, knowledge and evidence digests are unkeyed sha256 and
 * prove nothing either way.
 *
 * Every artifact is reported as `absent`, `empty`, `mac-bearing` or `unknown`.
 * Only `ENOENT` proves absence, and only a 0-byte regular file or a fully
 * schema-validated aggregate with zero markers proves "no MAC". Anything else
 * is `unknown`, never `empty`.
 *
 * `domain` is supplied by the report (which already read the aggregate): `null`
 * when it was absent or unreadable, otherwise `{applied, pendingApplied,
 * verified}`.
 */
function keyDerivedEvidence(paths, { bridge = null, domain } = {}) {
  const log = classifyArtifactPath(paths.eventBridgePath);
  if (log.state === ARTIFACT_MAC_BEARING) {
    log.records = bridge && Number.isInteger(bridge.lines) ? bridge.lines : countFileRecords(paths.eventBridgePath);
  } else if (log.state === ARTIFACT_ABSENT || log.state === ARTIFACT_EMPTY) {
    log.records = 0;
  }

  const domainFile = classifyArtifactPath(paths.domainGlobalPath);
  let aggregate = domainFile;
  if (domainFile.state === ARTIFACT_ABSENT || domainFile.state === ARTIFACT_EMPTY) {
    aggregate = { ...domainFile, applied: 0, pendingApplied: 0 };
  } else if (domainFile.state === ARTIFACT_MAC_BEARING) {
    if (domain && domain.verified === true && domain.applied !== null && domain.pendingApplied !== null) {
      aggregate = {
        ...domainFile,
        state: domain.applied > 0 || domain.pendingApplied > 0 ? ARTIFACT_MAC_BEARING : ARTIFACT_EMPTY,
        applied: domain.applied,
        pendingApplied: domain.pendingApplied,
      };
    } else {
      aggregate = { ...domainFile, state: ARTIFACT_UNKNOWN, applied: null, pendingApplied: null, reason: 'the aggregate did not fully validate, so its marker maps prove nothing' };
    }
  }

  const checkpointPath = eventLogCheckpointPath(paths.dataRoot);
  const temporaries = checkpointTemporaries(paths.dataRoot, path.basename(checkpointPath));
  const checkpointFile = classifyArtifactPath(checkpointPath);
  const checkpoint = {
    path: checkpointPath,
    ...checkpointFile,
    temporaries: temporaries.names,
    ...(temporaries.error ? { temporaryListingError: temporaries.error } : {}),
  };
  // A temporary can hold the same MAC bytes as the checkpoint, and a directory
  // that could not be listed may contain one this report never saw. Either way
  // the artifact is unproven; a checkpoint that is already MAC-bearing keeps
  // that (stronger) state.
  if (checkpoint.state !== ARTIFACT_MAC_BEARING && (temporaries.error !== null || (temporaries.names?.length ?? 0) > 0)) {
    checkpoint.state = ARTIFACT_UNKNOWN;
  }

  const artifacts = {
    'execution-events.jsonl': { path: paths.eventBridgePath, ...log },
    'evolution_domain.json': { path: paths.domainGlobalPath, ...aggregate },
    'event-log.checkpoint.json': checkpoint,
  };
  const byState = (state) => Object.entries(artifacts).filter(([, artifact]) => artifact.state === state).map(([name]) => name);
  return {
    artifacts,
    macBearing: byState(ARTIFACT_MAC_BEARING),
    unknown: byState(ARTIFACT_UNKNOWN),
    establishedWithoutMac: [...byState(ARTIFACT_ABSENT), ...byState(ARTIFACT_EMPTY)],
  };
}

/**
 * The single owner of the event-bridge key verdict. Report-only: the doctor
 * never creates, replaces, moves or deletes the key.
 *
 * The runtime (lib/index.js `storageConfig()`) creates the key when the path is
 * free and refuses every file that is not 64 lowercase hex characters, because
 * replacing it invalidates every MAC already written with it. That refusal is
 * not changed here.
 *
 * No automatic repair is possible even when no MAC is on disk: `storageConfig()`
 * initialises the key before the domain archive lock is ever taken, and the event
 * bridge keeps the key it read for its whole lifetime, so a live process may
 * already hold a key in memory and keep signing with it after any replacement.
 * Nothing the doctor can inspect proves that no such process exists, and
 * `keyDerivedEvidence` below cannot prove "no MAC bytes exist" either (a failed
 * `lstat`, an unvalidated aggregate and a checkpoint temporary are all unknown).
 * So the check reports what it established and gives the operator an
 * instruction; it writes nothing.
 */
function diagnoseEventBridgeKey(report, paths, { key, bridge, domain }) {
  const artifacts = keyDerivedEvidence(paths, { bridge, domain });
  const { macBearing, unknown } = artifacts;
  const evidence = {
    keyPath: paths.keyPath,
    state: key.state,
    present: key.present,
    bytes: key.bytes,
    mode: key.mode,
    regularFile: key.regularFile,
    ...(key.targetKind ? { targetKind: key.targetKind } : {}),
    ...(key.statError ? { statError: key.statError } : {}),
    ...(key.symlink ? { symlink: true } : {}),
    ...(key.readError ? { readError: key.readError } : {}),
    keyDerivedArtifacts: artifacts,
    macBearingArtifacts: macBearing,
    unknownArtifacts: unknown,
    repairPolicy: 'none: the doctor never creates, replaces or deletes the event-bridge key',
  };
  if (key.state === 'valid') {
    addCheck(report, {
      id: 'data.key', category: 'data', level: LEVEL.OK,
      summary: 'The event bridge key is valid (64 lowercase hex characters); no replacement is needed and none is offered.',
      evidence,
    });
    return artifacts;
  }
  if (key.state === 'absent') {
    if (macBearing.length > 0) {
      addCheck(report, {
        id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
        summary: `The event bridge key is missing while ${macBearing.length} key-derived MAC artifact(s) exist (${macBearing.join(', ')}); a fresh key would invalidate every recorded MAC.`,
        evidence,
        remediation: 'Restore the original event-bridge.key from a backup before starting the plugin. A replacement invalidates every envelope, applied marker and replay checkpoint written with the original, so the doctor never creates one here.',
        recoverable: false,
      });
    } else if (unknown.length > 0) {
      addCheck(report, {
        id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
        summary: `The event bridge key is missing, and the doctor cannot establish whether key-derived MAC data exists: ${unknown.join(', ')} could not be read as an empty artifact.`,
        evidence,
        remediation: 'Resolve the unknown artifacts first (fix what makes them unreadable or unvalidated); until then neither starting the plugin nor creating a key is provably safe, and the doctor writes nothing.',
        recoverable: false,
      });
    } else {
      addCheck(report, {
        id: 'data.key', category: 'data', level: LEVEL.DEGRADED,
        summary: 'The event bridge key is absent; no key-derived MAC is on disk (every artifact is absent or empty), so the next start creates the key, exactly as the runtime does whenever the path is free.',
        evidence,
        remediation: 'Start the plugin once; storageConfig() creates a fresh key. Nothing has to be repaired by hand.',
        recoverable: true,
      });
    }
    return artifacts;
  }
  const shape = key.state === 'empty'
    ? 'an empty file (0 bytes)'
    : `${key.readError ? `unreadable (${key.readError})` : 'present'} and not 64 lowercase hex characters (${key.bytes} bytes)`;
  if (key.readError) {
    addCheck(report, {
      id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
      summary: `The event bridge key could not be read (${key.readError}); the runtime cannot start and the doctor cannot establish what the entry holds.`,
      evidence,
      remediation: `Inspect ${paths.keyPath} and its permissions by hand; the doctor makes no claim about its contents and writes nothing.`,
      recoverable: false,
    });
    return artifacts;
  }
  if (!key.regularFile) {
    addCheck(report, {
      id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
      summary: `The event bridge key path is not a regular file (${key.targetKind || 'non-regular entry'}), so the doctor does not open it and cannot prove the bytes are this installation's key. The runtime refuses to start.`,
      evidence,
      remediation: `Inspect ${paths.keyPath} by hand: only a regular file holding 64 lowercase hex characters is accepted, and the doctor never replaces whatever is there.`,
      recoverable: false,
    });
    return artifacts;
  }
  if (macBearing.length > 0) {
    addCheck(report, {
      id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
      summary: `The event bridge key is unusable: it is ${shape}, and ${macBearing.length} key-derived MAC artifact(s) exist (${macBearing.join(', ')}). The runtime refuses to start rather than replace it, and a replacement would invalidate every recorded MAC.`,
      evidence,
      remediation: 'Restore the original event-bridge.key from a backup. It cannot be reconstructed from the MAC-bearing artifacts, and replacing it destroys their verifiability.',
      recoverable: false,
    });
    return artifacts;
  }
  if (unknown.length > 0) {
    addCheck(report, {
      id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
      summary: `The event bridge key is unusable (${shape}), and the doctor cannot establish whether key-derived MAC data exists: ${unknown.join(', ')} could not be read as an empty artifact.`,
      evidence,
      remediation: 'Resolve the unknown artifacts first; moving the key aside while MAC bytes the doctor could not read might still exist would invalidate them, so the doctor writes nothing.',
      recoverable: false,
    });
    return artifacts;
  }
  addCheck(report, {
    id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
    summary: `The event bridge key is unusable: it is ${shape}. No key-derived MAC is on disk (every artifact is absent or empty), but the runtime still refuses to start and the doctor never writes the key.`,
    evidence,
    remediation: 'Stop the application first: a running process keeps the key it read in memory and would keep signing with it. Then move the empty or unusable file aside (do not overwrite it) and start the plugin once so storageConfig() creates a fresh key. The doctor does not create, replace or delete the key itself.',
    recoverable: false,
  });
  return artifacts;
}

function diagnoseDataRoot(report, paths, { live = false, installed = false, inspectArchiveLock = null } = {}) {
  const stat = statSafe(paths.dataRoot);
  // The archive lock is read by the runtime's own classifier, not by the
  // promotion directory-lock reader: the two entries are different protocols.
  const lock = inspectArchiveLock ? inspectArchiveLock(paths.domainArchiveLockPath) : null;
  const storagesDir = path.dirname(paths.dataRoot);
  const storagesStat = statSafe(storagesDir);
  const blocking = [];
  const advisory = [];
  let entryCount = 0;
  if (!stat) {
    if (live) blocking.push('data root does not exist while the plugin is running');
    else if (storagesStat && installed) blocking.push('the storages directory exists and the bundle is installed, but the Evolution data root was removed');
    else advisory.push('data root is not initialized yet (created on first run)');
  } else {
    if (!stat.isDirectory()) blocking.push('data root is not a directory');
    else {
      if (stat.isSymbolicLink()) blocking.push('data root is a symlink');
      try { entryCount = fs.readdirSync(paths.dataRoot).length; } catch { advisory.push('data root cannot be listed'); }
      try { fs.accessSync(paths.dataRoot, fs.constants.W_OK); } catch { blocking.push('data root is not writable'); }
      // The key is deliberately not mentioned here at all: data.key is its only
      // owner, and a second opinion on this check is what used to contradict the
      // runtime's own create-on-first-start behaviour.
    }
  }
  const problems = [...blocking, ...advisory];
  const level = blocking.length > 0 ? LEVEL.BLOCKED : advisory.length > 0 ? LEVEL.DEGRADED : LEVEL.OK;
  addCheck(report, {
    id: 'data.root', category: 'data', level,
    summary: blocking.length > 0
      ? `The Evolution data root is unusable: ${blocking.join('; ')}.`
      : advisory.length > 0
        ? `The Evolution data root is not initialized yet: ${advisory.join('; ')}.`
        : `Evolution data root is present and writable (${stat ? (stat.mode & 0o777).toString(8) : 'absent'}).`,
    evidence: {
      dataRoot: paths.dataRoot,
      exists: Boolean(stat),
      mode: stat ? (stat.mode & 0o777).toString(8) : null,
      symlink: Boolean(stat?.isSymbolicLink()),
      writable: Boolean(stat?.isDirectory()) && !blocking.includes('data root is not writable'),
      entries: stat?.isDirectory() ? entryCount : null,
      archiveLock: archiveLockEvidence(lock),
      problems,
      blockingProblems: blocking,
      advisoryProblems: advisory,
    },
    remediation: blocking.length > 0
      ? 'Restore or recreate the data root before starting the plugin.'
      : advisory.length > 0 ? 'Start the plugin once; it creates the data root.' : undefined,
    recoverable: false,
  });
}

async function diagnosePlatformVersion(report, paths) {
  const manifest = readPeerRange();
  const hostPkg = resolveFrom(path.join(PACKAGE_ROOT, 'package.json'), '@deepseek-ai/dsh/package.json');
  addCheck(report, {
    id: 'plugin.support-matrix', category: 'plugin', level: LEVEL.OK,
    summary: `Bundle ${manifest.version ?? 'unknown'} supports @deepseek-ai/dsh ${manifest.peers['@deepseek-ai/dsh'] ?? 'unknown'} and Node ${JSON.stringify(readJsonSafe(path.join(PACKAGE_ROOT, 'package.json')).value?.engines?.node ?? 'unspecified')}.`,
    evidence: {
      bundleVersion: manifest.version,
      supportedDsh: manifest.peers['@deepseek-ai/dsh'] ?? null,
      verifiedHosts: SUPPORTED_DSH_VERSIONS,
      peers: manifest.peers,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dataRoot: paths.dataRoot,
      developmentHost: hostPkg.version ? { version: hostPkg.version, resolved: hostPkg.resolved } : null,
    },
  });
  return manifest;
}

async function diagnoseMemory(report, paths) {
  const stat = statSafe(paths.memoryPath);
  const quarantines = fs.existsSync(paths.dataRoot)
    ? fs.readdirSync(paths.dataRoot).filter((name) => name.startsWith('evolution-memory.json.quarantine-')).sort()
    : [];
  if (quarantines.length > 0) {
    addCheck(report, {
      id: 'state.memory-quarantine', category: 'state', level: LEVEL.DEGRADED,
      summary: `${quarantines.length} quarantined failure-memory file(s) exist; their content was not read at startup.`,
      evidence: { quarantines: quarantines.map((name) => path.join(paths.dataRoot, name)) },
      remediation: 'Inspect the quarantined files and merge anything still needed; the doctor never deletes evidence.',
      recoverable: false,
    });
  }
  if (!stat) {
    addCheck(report, {
      id: 'state.memory', category: 'state', level: LEVEL.OK,
      summary: quarantines.length > 0
        ? `No active failure memory; ${quarantines.length} quarantined file(s) are preserved.`
        : 'No failure memory file yet (fresh install).',
      evidence: { memoryPath: paths.memoryPath, present: false, quarantines },
    });
    return;
  }
  const parsed = readJsonSafe(paths.memoryPath);
  const problems = [];
  if (parsed.error) problems.push(`not valid JSON: ${String(parsed.error.message || parsed.error)}`);
  else {
    if (parsed.value?.schema !== 1) problems.push(`unsupported schema ${JSON.stringify(parsed.value?.schema)} (expected 1)`);
    if (!Array.isArray(parsed.value?.entries)) problems.push('entries is not an array');
    // The runtime quarantines a file whose records are not objects or nest past
    // its load bound; reporting it here at the same level keeps the doctor from
    // calling that state healthy.
    else if (!parsed.value.entries.every(isUsableMemoryEntry)) problems.push('entries contains a record the runtime quarantines (not an object, or nested too deeply)');
    // The runtime also quarantines a file whose pre-parse content a parse cannot
    // preserve exactly - a lossy number literal, a duplicate key, a lossy
    // decode; in `parsed.value` those differences are gone.
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(paths.memoryPath)); } catch { text = null; }
    if (text === null) problems.push('the file is not valid UTF-8');
    else {
      const inspection = inspectMemoryText(text);
      if (!inspection.ok) problems.push(inspection.reason === 'duplicate-key-failure'
        ? 'an object in this file has duplicate keys'
        : 'a number literal in this file does not survive JSON.parse exactly');
    }
  }
  if (problems.length > 0) {
    addCheck(report, {
      id: 'state.memory', category: 'state', level: LEVEL.DEGRADED,
      summary: 'The failure memory file is damaged; the orchestrator quarantines it and starts empty instead of trusting it.',
      evidence: {
        memoryPath: paths.memoryPath, bytes: stat.size, problems,
        behavior: 'on next start the file is renamed to evolution-memory.json.quarantine-<pid>-<time> and preserved',
        quarantines,
      },
      remediation: 'Nothing to do for safety: the original bytes are preserved by quarantine and a queryable warning is recorded.',
      recoverable: true,
    });
    return;
  }
  addCheck(report, {
    id: 'state.memory', category: 'state', level: LEVEL.OK,
    summary: `Failure memory parses with ${parsed.value.entries.length} record(s).`,
    evidence: { memoryPath: paths.memoryPath, bytes: stat.size, schema: parsed.value.schema, entries: parsed.value.entries.length, quarantines },
  });
}

async function diagnoseArchives(report, paths) {
  const problems = [];
  const evidence = { dir: paths.archiveDir, archives: 0, unreadable: [], malformed: [], dockyard: {} };
  if (fs.existsSync(paths.archiveDir)) {
    const files = fs.readdirSync(paths.archiveDir).filter((name) => name.endsWith('.md')).sort();
    evidence.archives = files.length;
    for (const name of files) {
      const file = path.join(paths.archiveDir, name);
      try {
        const text = fs.readFileSync(file, 'utf8');
        if (!/^# Evolution experiment /m.test(text)) evidence.malformed.push(name);
      } catch (error) {
        evidence.unreadable.push({ name, error: String(error.message || error) });
      }
    }
  } else evidence.dir = null;
  if (evidence.unreadable.length > 0) problems.push(`${evidence.unreadable.length} archive file(s) unreadable`);
  if (evidence.malformed.length > 0) problems.push(`${evidence.malformed.length} archive file(s) without the experiment header`);

  const dockyardFiles = fs.existsSync(paths.dockyardDir)
    ? fs.readdirSync(paths.dockyardDir).sort()
    : [];
  evidence.dockyard.files = dockyardFiles;
  evidence.dockyard.sealTemporaries = [];
  for (const name of dockyardFiles.filter((name) => /^state\.json\..*-archive\.jsonl\.segments$/.test(name))) {
    try {
      for (const entry of fs.readdirSync(path.join(paths.dockyardDir, name))) {
        if (/^\.segment-[0-9a-f-]+\.tmp$/.test(entry)) evidence.dockyard.sealTemporaries.push(path.join(name, entry));
      }
    } catch { problems.push(`${name} cannot be inspected for seal temporaries`); }
  }
  if (evidence.dockyard.sealTemporaries.length) problems.push(`${evidence.dockyard.sealTemporaries.length} seal temporary file(s); ownership and loss are unproven, preserved without repair`);

  let legacyState;
  const stateFile = path.join(paths.dockyardDir, 'state.json');
  if (statSafe(stateFile)) {
    const parsed = readJsonSafe(stateFile);
    legacyState = dockyardMemoryCheck(paths, parsed);
    if (parsed.error) {
      evidence.dockyard.state = { parse: 'failed', error: String(parsed.error.message || parsed.error) };
      problems.push('dockyard/state.json is not valid JSON');
    } else {
      const schema = parsed.value?.evolution?.schema ?? parsed.value?.schema ?? null;
      evidence.dockyard.state = { parse: 'ok', schema, partitions: Object.keys(parsed.value || {}) };
      if (typeof schema !== 'number') problems.push('dockyard/state.json has no numeric evolution schema');
    }
  } else evidence.dockyard.state = { present: false };

  const jsonlFiles = dockyardFiles.filter((name) => /^state\.json\..*\.jsonl$/.test(name) || /\.jsonl$/.test(name));
  evidence.dockyard.jsonl = [];
  for (const name of jsonlFiles) {
    const file = path.join(paths.dockyardDir, name);
    let inspected;
    try { inspected = inspectJsonLinesFileSummary(file); } catch (error) { problems.push(`${name} unreadable`); evidence.dockyard.jsonl.push({ name, error: String(error.message || error) }); continue; }
    const invalid = inspected.invalid;
    evidence.dockyard.jsonl.push({ name, lines: inspected.lineCount, invalid, truncatedTail: inspected.truncatedTail });
    if (invalid > 0) problems.push(`${name} has ${invalid} unparsable line(s)`);
    if (inspected.truncatedTail) problems.push(`${name} ends with a partial line (interrupted write)`);
  }
  const indexFile = path.join(paths.dockyardDir, 'state.json.evolution-archive-index.json');
  if (statSafe(indexFile)) {
    const parsed = readJsonSafe(indexFile);
    evidence.dockyard.index = parsed.error ? { parse: 'failed', error: String(parsed.error.message || parsed.error) } : { parse: 'ok' };
    if (parsed.error) problems.push('the archive index is not valid JSON');
  }
  const archiveIntegrity = inspectArchiveIntegrity({
    stateFile,
    indexFile,
    domainGlobalPath: paths.domainGlobalPath,
  });
  evidence.dockyard.archiveIntegrity = archiveIntegrity;
  for (const finding of archiveIntegrity.findings) {
    const location = [finding.collection, finding.file ?? finding.path].filter(Boolean).join('/');
    const detail = finding.code === 'archive-target-undetermined'
      ? ' (a pending install or compaction transition prevents a permanent-loss conclusion)'
      : finding.code === 'archive-index-target-missing' || finding.code === 'archive-loss-evidence'
        ? ' (expected bytes are missing or unproven; loss cause is not proven)'
        : '';
    problems.push(`${finding.code}${location ? `: ${location}` : ''}${detail}`);
  }
  addCheck(report, {
    id: 'state.archives', category: 'state', level: problems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
    summary: problems.length > 0
      ? `Cold archives and rotation files have ${problems.length} integrity issue(s); the append-only originals are preserved.`
      : `Cold archive and rotation files are readable (${evidence.archives} experiment file(s)).`,
    evidence: { ...evidence, problems },
    remediation: problems.length > 0 ? 'Preserve the originals. Resolve any pending install or compaction transition first; rebuilding the index alone does not prove that missing archive bytes were recovered.' : undefined,
    recoverable: false,
  });
  return legacyState;
}

/**
 * Resolve the writer the doctor must expect on the event bridge.
 *
 * An explicit `config.eventBridgeWriter` is authoritative: in-session
 * diagnostics receive the same resolved config the runtime binds the bridge to,
 * and the runtime reads it as `config.eventBridgeWriter || DEFAULT` (no
 * trimming, no fallback to the composed profile). The CLI entry has no config,
 * so it falls back to the writer state the composed profile produced, and only
 * when the profile does not state one at all to the bundle default. A profile
 * that does not determine the value is never defaulted: it resolves to
 * `writerSource: 'unknown'` with `writer: null`, and the caller reports it as
 * degraded instead of verifying the log against a writer the runtime may not
 * use.
 */
function resolveTrustedWriter(config, composition) {
  if (config !== undefined && config !== null) {
    return { writer: config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER, writerSource: 'config' };
  }
  if (composition?.unreadable === true) {
    return { writer: null, writerSource: 'unknown', writerExpectationReason: composition.reason ?? 'unreadable-composition' };
  }
  if (typeof composition?.writer === 'string' && composition.writer !== '') {
    return { writer: composition.writer, writerSource: 'composition' };
  }
  return { writer: EVENT_BRIDGE_DEFAULT_WRITER, writerSource: 'bundle-default' };
}

async function diagnoseEventBridge(report, paths, { key, keyValid = true, keyState = 'valid', writer, writerSource = 'bundle-default', writerExpectationReason = null }, { scanState = null } = {}) {
  const stat = statSafe(paths.eventBridgePath);
  if (!stat) {
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.OK,
      summary: 'No execution event bridge yet (fresh install).',
      evidence: { eventBridgePath: paths.eventBridgePath, present: false },
    });
    return null;
  }
  // The key is tested for validity, not truthiness: a present-but-not-64-hex key
  // would still HMAC-verify a log that was signed with such a key, and reporting
  // that as `ok` would contradict data.key and storageConfig(), which refuses to
  // start on it. A bridge with no bytes has no envelope to verify, so an unusable
  // key is not a verification failure there.
  if (!keyValid) {
    if (stat.size > 0) {
      addCheck(report, {
        id: 'state.event-bridge', category: 'state', level: LEVEL.BLOCKED,
        summary: 'The event bridge holds records but its signing key is absent or unusable, so no record can be verified.',
        evidence: { eventBridgePath: paths.eventBridgePath, bytes: stat.size, keyAvailable: key !== null && key !== '', keyValid: false, keyState, verificationAttempted: false },
        remediation: 'Restore the original event-bridge.key; without it every envelope fails verification and the plugin refuses to start. The key verdict itself belongs to the data.key check, which names the evidence.',
        recoverable: false,
      });
      return null;
    }
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.OK,
      summary: 'The execution event bridge is empty, so no envelope needs a signing key yet.',
      evidence: { eventBridgePath: paths.eventBridgePath, present: true, bytes: stat.size, lines: 0, keyValid: false, keyState },
    });
    return null;
  }
  const unverifiable = [];
  const malformed = [];
  const untrustedWriters = [];
  const writersSeen = [];
  // `writerSource: 'unknown'` means the composed profile did not determine the
  // value: the MAC-level checks still run, but no record is judged untrusted
  // against a writer this diagnostic could not read. Any other source is a
  // concrete expectation (a config value, a stated composition value or the
  // bundle default), including a non-string config value, which the runtime
  // would also compare verbatim and reject every string writer for.
  const writerKnown = writerSource !== 'unknown';
  const byEventId = new Map();
  const conflicts = [];
  let duplicates = 0;
  let oldestRecordAt = null;
  let newestRecordAt = null;
  let inspected;
  try {
    inspected = scanJsonLinesFile(paths.eventBridgePath, (lineText, line) => {
      if (lineText.trim() === '') return;
      let value;
      try { value = JSON.parse(lineText); } catch (error) {
        malformed.push({ line, error: redactJsonParseMessage(String(error?.message ?? error)) });
        return;
      }
      const verified = verifyEventBridgeEnvelope(value, key);
      if (!verified) { unverifiable.push({ line, sequence: value?.sequence ?? null, writer: value?.writer ?? null }); return; }
      if (writerKnown) {
        if (!eventBridgeWriterTrusted(verified, writer)) { untrustedWriters.push({ line, sequence: verified.sequence, writer: verified.writer }); return; }
      } else if (typeof verified.writer === 'string' && !writersSeen.includes(verified.writer)) {
        writersSeen.push(verified.writer);
      }
      const at = verified.event?.audit?.at;
      // Only a timestamp-shaped value takes part in the range. `audit.at` is
      // producer-generated, but a payload may carry anything, and comparing a
      // non-ISO string would report a range that is not one.
      if (typeof at === 'string' && ISO_TIMESTAMP.test(at)) {
        if (oldestRecordAt === null || at < oldestRecordAt) oldestRecordAt = at;
        if (newestRecordAt === null || at > newestRecordAt) newestRecordAt = at;
      }
      const eventId = typeof verified.event?.eventId === 'string' ? verified.event.eventId : null;
      if (!eventId) return;
      const mac = value.mac;
      const previous = byEventId.get(eventId);
      if (previous && previous !== mac) conflicts.push({ eventId, lines: previous, mac });
      else if (previous) duplicates += 1;
      else byEventId.set(eventId, mac);
    });
  } catch (error) {
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.BLOCKED,
      summary: 'The execution event bridge is unreadable.',
      evidence: { eventBridgePath: paths.eventBridgePath, error: String(error.message || error) },
      recoverable: false,
    });
    return null;
  }
  const problems = [];
  if (malformed.length > 0) problems.push(`${malformed.length} malformed line(s)`);
  if (unverifiable.length > 0) problems.push(`${unverifiable.length} envelope(s) fail MAC verification`);
  if (untrustedWriters.length > 0) problems.push(`${untrustedWriters.length} envelope(s) name a writer other than ${writer} (signed by: ${[...new Set(untrustedWriters.map((entry) => entry.writer))].slice(0, 4).join(', ')})`);
  if (conflicts.length > 0) problems.push(`${conflicts.length} event id(s) recorded with conflicting MACs`);
  const truncated = inspected.truncatedTail && malformed.some((entry) => entry.line === inspected.lineCount);
  // Dropping the unterminated tail only leaves a verified file when there is a
  // complete line in front of it; a single partial record has no prefix to keep
  // and must be handled by hand.
  const hasCompletePrefix = inspected.hasCompletePrefix;
  const evidence = {
    eventBridgePath: paths.eventBridgePath, bytes: stat.size, lines: inspected.lineCount,
    verifiedEvents: byEventId.size, duplicateRecords: duplicates,
    unverifiable, malformed: malformed.slice(0, 8), conflicts: conflicts.slice(0, 8),
    untrustedWriters: untrustedWriters.slice(0, 8),
    truncatedTail: truncated,
    trustedWriter: writer, writerSource,
    ...(writerExpectationReason ? { writerExpectationReason } : {}),
    ...(writerKnown ? {} : { writersSeen }),
  };
  if (scanState) Object.assign(scanState, { evidence, eventIds: [...byEventId.keys()], oldestRecordAt, newestRecordAt });
  if (problems.length > 0) {
    const repair = truncated && malformed.length === 1 && unverifiable.length === 0 && conflicts.length === 0 && untrustedWriters.length === 0 && hasCompletePrefix
      ? {
        id: 'event-bridge-trim-partial-tail',
        safe: true,
        description: `Drop the unterminated final line ${inspected.lineCount} (${malformed[0].error}); no complete record is removed.`,
      }
      : undefined;
    const onlyPartialTail = truncated && malformed.length === 1 && unverifiable.length === 0 && conflicts.length === 0 && untrustedWriters.length === 0;
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.BLOCKED,
      summary: `The event bridge cannot be replayed as-is: ${problems.join('; ')}.`,
      evidence,
      remediation: conflicts.length > 0
        ? 'Conflicting MACs mean the same event id was recorded with different content; freeze the file and resolve by hand (the plugin refuses to guess).'
        : untrustedWriters.length > 0
          ? `Records signed by another writer cannot be replayed: this installation only trusts \`${writer}\` (${writerSource}). Restore the log this installation wrote, or freeze the file and resolve by hand. If this installation configures a different eventBridgeWriter that the doctor could not read (--no-composition, or the profile does not state it), run the diagnostic with --profile so the composed profile is read.`
          : onlyPartialTail && !hasCompletePrefix
            ? 'The file is a single unterminated record with no verified complete prefix to keep, so no automatic repair is offered; freeze the file and resolve it by hand.'
            : 'Restore the original key or the original file; the plugin refuses to start on unverifiable events.',
      recoverable: Boolean(repair),
      ...(repair ? { repair } : {}),
    });
    return { ...evidence, problems };
  }
  if (!writerKnown) {
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.DEGRADED,
      summary: `Event bridge MAC-verifies: ${byEventId.size} signed event(s), ${duplicates} idempotent duplicate(s), but this installation's trusted writer could not be read from the composed profile, so the log was not checked against it.`,
      evidence,
      remediation: 'Make the configured writer readable (remove an inline `config:`, a YAML tag or a template expression from `evolution-orchestrator.config.eventBridgeWriter` in the profile) or run the diagnostic in session with the resolved config, so the writer identity the runtime enforces can be verified.',
    });
    return { ...evidence, problems };
  }
  addCheck(report, {
    id: 'state.event-bridge', category: 'state', level: LEVEL.OK,
    summary: `Event bridge verifies: ${byEventId.size} signed event(s), ${duplicates} idempotent duplicate(s), verified against the trusted writer \`${writer}\` (${writerSource}).`,
    evidence,
  });
  return { ...evidence, problems };
}

function diagnoseRetentionFloor(report, paths, key, domain) {
  let status = 'no-floor';
  let level = LEVEL.OK;
  // The committed document and the one a pending record would install in its
  // place are judged together: the pending one is installed by `installPending()`
  // on the next start, so it is the floor the runtime will run with, and a pair
  // that would move the floor backwards un-proves bytes a reclaim already removed.
  // `diagnoseDomain()` always reports the committed document, including `null`:
  // a fallback to the pending floor would label one contradiction twice and
  // blame the pending record for what the committed one already says.
  const committed = domain?.committedRetention ?? null;
  const pending = domain?.pendingRetention ?? null;
  const floor = pending ?? committed;
  const floorSource = pending ? 'pending' : committed ? 'committed' : 'none';
  // A reclaim temporary can only exist beside a floor, and this listing is one
  // more directory read: it is asked for only when there is something to explain.
  const temporaries = floor === null ? { names: [], error: null } : floorTemporaries(paths);
  let continuity = [];
  let presentable = false;
  if (domain?.verified !== true) { status = 'domain-unverified'; level = LEVEL.NOT_EVALUATED; }
  else {
    presentable = [committed, pending]
      .every((document) => document === null || validRetentionDocument(document) !== null);
    if (!presentable) { status = 'invalid-floor'; level = LEVEL.BLOCKED; }
    else {
      // Continuity is decided before the file is classified: a floor that could
      // not have been written by this version must not be reported as a healthy
      // retention simply because the retained bytes still match its digest.
      continuity = inspectRetentionContinuity({ committed, pending });
      if (continuity.length > 0) { status = 'floor-inconsistent'; level = LEVEL.BLOCKED; }
      else if (floor?.log) {
        if (key.state !== 'valid') { status = 'key-unavailable'; level = LEVEL.NOT_EVALUATED; }
        else {
          try { ({ status } = inspectEventLogFloor({ file: paths.eventBridgePath, key: key.text, floor })); }
          catch { status = 'unreadable'; }
          level = status === 'already-truncated' ? LEVEL.OK : status === 'deferred' ? LEVEL.DEGRADED : LEVEL.BLOCKED;
        }
      }
    }
  }
  // The floor's own counters are reported so an operator can compare two runs:
  // `log.bytes`/`log.records` are cumulative discards, `markers.pruned` is the
  // cumulative marker retirement, and `tail.bytes` is how much log is kept.
  const projection = !presentable || floor === null ? null : {
    markers: { pruned: floor.markers.pruned, chain: floor.markers.chain },
    // `validRetentionDocument()` projects a missing `log` key to `null` as well, so
    // "no log floor" is every non-truthy value here rather than `null` alone.
    log: floor.log ? { bytes: floor.log.bytes, records: floor.log.records,
      prior: floor.log.prior.bytes, tail: floor.log.tail.bytes } : null,
  };
  addCheck(report, {
    id: 'state.retention-floor', category: 'state', level,
    summary: `Event log retention continuity: ${status}.`
      + (continuity.length > 0 ? ` The ${floorSource} floor contradicts itself: ${continuity.map((problem) => problem.code).join(', ')}.` : '')
      + (temporaries.names?.length > 0 ? ` ${temporaries.names.length} reclaim temporary file(s) preserved.` : ''),
    evidence: { status, floorSource, eventBridgePath: paths.eventBridgePath, floor: projection,
      floorProblems: continuity, reclaimTemporaries: temporaries.names,
      ...(temporaries.error ? { reclaimTemporaryListingError: temporaries.error } : {}) },
    recoverable: false,
    remediation: status === 'floor-inconsistent'
      ? 'Preserve the data root and restore the committed domain document from a backup: a floor that records markers without a chain (or a pending floor behind the committed one) cannot prove what a reclaim removed, and the doctor never rewrites a floor.'
      : level === LEVEL.BLOCKED ? 'Preserve the data root. Restore the retained log bytes or use a new data root; the doctor never rewrites the log or guesses a floor.'
        : status === 'deferred' ? 'The committed truncation is pending; runtime recovery completes it under the append lock. No doctor repair is needed.' : undefined,
  });
}

/** The truncation temporaries a crashed rewrite can leave beside the log. They
 *  hold the retained bytes of that rewrite until the next completion removes
 *  them, so they are listed and preserved, never treated as reclaimable. */
function floorTemporaries(paths) {
  const directory = path.dirname(paths.eventBridgePath);
  const prefix = `${path.basename(paths.eventBridgePath)}.`;
  try {
    return { names: fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && /^[0-9a-f]{16}\.reclaim\.tmp$/.test(name.slice(prefix.length)))
      .sort(), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { names: [], error: null };
    return { names: [], error: error?.code || 'READDIR_FAILED' };
  }
}

function addEventBridgeCapacityEvidence(scanState, domain) {
  if (!scanState?.evidence || domain?.verified !== true || !Array.isArray(domain.appliedMarkers)) return;
  const appliedMarkers = new Set(domain.appliedMarkers);
  let absorbedRecords = 0;
  for (const eventId of scanState.eventIds) if (appliedMarkers.has(eventId)) absorbedRecords += 1;
  Object.assign(scanState.evidence, {
    absorbedRecords,
    unabsorbedRecords: scanState.eventIds.length - absorbedRecords,
    oldestRecordAt: scanState.oldestRecordAt,
    newestRecordAt: scanState.newestRecordAt,
  });
}

/** The archive-lock evidence a report carries. `raw` is bounded: the body is
 *  normally a pid, but a corrupted entry can hold arbitrary bytes that must not
 *  be reproduced in full in a shareable report. */
function archiveLockEvidence(lock) {
  if (!lock) return null;
  return { ...lock, raw: typeof lock.raw === 'string' ? lock.raw.slice(0, 64) : lock.raw };
}

/**
 * The archive lock's verdict, from the runtime's own classifier (exported by
 * lib/domain-storage.js). The doctor does not decide what the entry means: it
 * only splits the classifier's answer into an advisory the check reports, a
 * blocking problem, and whether the `domain-stale-lock` repair is justified.
 *
 * A non-regular or uninterpretable entry is a blocking problem and never a
 * candidate for the repair: the acquiring port refuses it (`E_DOMAIN_ARCHIVE_LOCK`)
 * instead of interpreting or removing it, so reporting it as "stale, repairable"
 * would tell the operator the opposite of what the runtime does.
 */
function domainArchiveLockVerdict(lock, lockPath) {
  if (!lock) {
    // The classifier could not be loaded (a clean install with no node_modules).
    // Refuse to interpret the file, but do not call a lock that exists "fine":
    // only ENOENT proves there is nothing there.
    let stat;
    try { stat = fs.lstatSync(lockPath); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return { problems: [], advisory: ['the domain archive lock could not be inspected because the runtime lock module is unavailable, and no entry exists at that path'], stale: false, unavailable: true };
      }
      return { problems: [`the archive lock cannot be inspected because the runtime lock module is unavailable (lstat failed: ${error?.code || 'STAT_FAILED'})`], advisory: [], stale: false, unavailable: true };
    }
    return { problems: [`the archive lock cannot be inspected because the runtime lock module is unavailable, and an entry exists at ${lockPath}`], advisory: [], stale: false, unavailable: true };
  }
  if (!lock.present) return { problems: [], advisory: [], stale: false };
  if (lock.reclaimable) {
    return {
      problems: [],
      advisory: [lock.malformed
        ? 'the domain archive lock holds no readable owner (an interrupted writer left it behind) and the runtime reclaims it'
        : 'the domain archive lock names a process that is no longer running and the runtime reclaims it on the next start'],
      stale: true,
    };
  }
  if (lock.ownerAlive) return { problems: [], advisory: [], stale: false };
  if (lock.kind !== 'file') {
    const what = lock.kind === 'unknown'
      ? `could not be read (${lock.readError || 'STAT_FAILED'})`
      : `is a ${lock.kind} entry`;
    return {
      problems: [`the domain archive lock ${what}, which the runtime refuses to interpret, so the plugin cannot open the archive until it is resolved`],
      advisory: [],
      stale: false,
    };
  }
  return {
    problems: [],
    advisory: ['the domain archive lock was modified inside the runtime settle window and names no readable owner yet; the runtime waits for that window before reclaiming it, so re-run the doctor'],
    stale: false,
  };
}

async function diagnoseDomain(report, paths, { migration, inspectArchiveLock = null } = {}) {
  const stat = statSafe(paths.domainGlobalPath);
  const staging = fs.existsSync(paths.domainStagingDir)
    ? fs.readdirSync(paths.domainStagingDir).filter((name) => STAGE_NAME.test(name)).sort()
    : [];
  // The archive lock is diagnosed even when the aggregate is absent: an
  // interrupted writer can leave a lock on a root that never got an aggregate,
  // and the plugin still cannot open the archive until it is resolved.
  const lock = inspectArchiveLock ? inspectArchiveLock(paths.domainArchiveLockPath) : null;
  const lockVerdict = domainArchiveLockVerdict(lock, paths.domainArchiveLockPath);
  const lockEvidence = { archiveLock: archiveLockEvidence(lock), staleLock: lockVerdict.stale };
  const staleLockRepair = lockVerdict.stale
    ? {
      id: 'domain-stale-lock',
      safe: true,
      description: 'Remove the unusable domain archive lock (no live owner) so the plugin can start; the runtime reclaims the same condition at startup.',
    }
    : undefined;
  if (!stat) {
    const problems = [...lockVerdict.problems];
    const advisory = [...lockVerdict.advisory];
    addCheck(report, {
      id: 'state.domain', category: 'state',
      level: problems.length > 0 ? LEVEL.BLOCKED : advisory.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
      summary: problems.length > 0
        ? `The domain archive lock cannot be used: ${problems.join('; ')}.`
        : advisory.length > 0
          ? `No domain aggregate yet, and its archive lock needs attention: ${advisory.join('; ')}.`
          : 'No domain aggregate yet; the host creates it from the empty initial state.',
      evidence: { domainGlobalPath: paths.domainGlobalPath, present: false, staging, ...lockEvidence, lockProblems: problems, lockAdvisory: advisory },
      ...(problems.length > 0
        ? { remediation: lockVerdict.unavailable
          ? 'Re-run the doctor from an installation whose dependencies are present; it does not interpret the archive lock without the runtime module, so nothing here was removed or read.'
          : 'Inspect the lock entry by hand; the runtime refuses to interpret or remove an entry that is not a regular pid file.' }
        : advisory.length > 0
          ? { remediation: lockVerdict.unavailable
            ? 'Re-run the doctor from an installation whose dependencies are present; it refuses to interpret the archive lock without the runtime module.'
            : 'Re-run the doctor with --repair (or restart the plugin) so the runtime reclaims the stale lock.' }
          : {}),
      ...(problems.length > 0 || advisory.length > 0 ? { recoverable: Boolean(staleLockRepair) } : {}),
      ...(staleLockRepair ? { repair: staleLockRepair } : {}),
    });
    return null;
  }
  const parsed = readJsonSafe(paths.domainGlobalPath);
  if (parsed.error) {
    const lockNote = [...lockVerdict.problems, ...lockVerdict.advisory];
    addCheck(report, {
      id: 'state.domain', category: 'state', level: LEVEL.BLOCKED,
      summary: `The domain storage unit is not valid JSON; the host cannot open it.${lockNote.length > 0 ? ` Its archive lock also needs attention: ${lockNote.join('; ')}.` : ''}`,
      evidence: { domainGlobalPath: paths.domainGlobalPath, bytes: stat.size, error: String(parsed.error.message || parsed.error), staging, ...lockEvidence, lockProblems: lockVerdict.problems, lockAdvisory: lockVerdict.advisory },
      remediation: 'Restore from a backup or move the file aside after copying it; the plugin never rewrites an unreadable domain unit.',
      recoverable: false,
    });
    return null;
  }
  const aggregate = await verifyDomainAggregate(parsed);
  const { value, problems, schemaErrors, verified } = aggregate;
  const pending = value.global?.pending ?? null;
  const appliedKeys = Object.keys(value.global?.applied ?? {});
  const advisory = [...aggregate.advisory, ...lockVerdict.advisory];
  const pendingState = !pending ? 'none' : STAGE_NAME.test(String(pending.stage || '')) ? (staging.includes(pending.stage) ? 'replayable' : 'missing-archive') : 'malformed';
  const blocking = [...problems, ...lockVerdict.problems];
  if (pendingState === 'missing-archive') blocking.push(`pending transaction references ${pending.stage} but that staging directory is absent`);
  if (pendingState === 'malformed') blocking.push('pending transaction has a malformed stage name');
  if (pendingState === 'replayable') advisory.push(`an interrupted write is replayable from staging ${pending.stage} on the next start`);
  const orphanStaging = staging.filter((name) => !pending || pending.stage !== name);
  if (orphanStaging.length > 0) advisory.push(`${orphanStaging.length} staging directorie(s) are not referenced by a pending transaction`);

  const repair = verified && orphanStaging.length > 0 && lock && (lock.kind === 'file' || lock.kind === 'absent') && !lock.ownerAlive
    ? {
      id: 'domain-orphan-staging',
      safe: true,
      description: `Remove ${orphanStaging.length} staging directorie(s) that no pending transaction references, with no live writer holding the archive lock and a verified domain aggregate.`,
    }
    : staleLockRepair;
  const level = blocking.length > 0 || schemaErrors?.length ? LEVEL.BLOCKED : advisory.length > 0 ? LEVEL.DEGRADED : LEVEL.OK;
  addCheck(report, {
    id: 'state.domain', category: 'state', level,
    summary: blocking.length === 0 && !schemaErrors?.length && advisory.length === 0
      ? `Domain aggregate schema 1 is valid (${appliedKeys.length} applied event marker(s)${pending ? ', replayable pending transaction' : ''}).`
      : blocking.length > 0 || schemaErrors?.length
        ? `Domain aggregate is unusable: ${[...blocking, ...(schemaErrors || []).map((issue) => `${issue.path}: ${issue.message}`)].join('; ')}.`
        : `Domain aggregate is consistent with ${advisory.length} recoverable condition(s): ${advisory.join('; ')}.`,
    evidence: {
      domainGlobalPath: paths.domainGlobalPath,
      bytes: stat.size,
      unit: value.unit ?? null,
      schema: value.global?.schema ?? null,
      applied: appliedKeys.length,
      pending: pending ? { stage: pending.stage ?? null, state: pendingState } : null,
      staging,
      orphanStaging,
      aggregateVerified: verified,
      schemaErrors,
      problems: [...blocking, ...advisory],
      blockingProblems: blocking,
      advisoryProblems: advisory,
      ...lockEvidence,
      lockProblems: lockVerdict.problems,
      migration: migration ? { importId: migration.importId ?? null } : null,
    },
    remediation: blocking.length > 0 || schemaErrors?.length
      ? pendingState === 'missing-archive'
        ? 'The host throws E_DOMAIN_PENDING_ARCHIVE_MISSING on start. Restore the staging directory from a backup, or restore the aggregate, before running any Evolution flow.'
        : 'Restore the domain storage unit from a backup. The plugin never rewrites an aggregate it cannot validate.'
      : advisory.length > 0 ? 'Restart the plugin to replay a pending transaction. Stop the application before removing orphan staging directories; a live writer may be mid-transaction.' : undefined,
    recoverable: Boolean(repair) || pendingState === 'replayable',
    ...(repair ? { repair } : {}),
  });
  // `pendingApplied` and `verified` are returned for the key verdict alone: the
  // marker maps are key-derived, and only a fully validated aggregate proves
  // them empty without the doctor reading the document a second time.
  const pendingApplied = !pending ? 0 : countRecordKeys(pending.applied ?? {});
  return { applied: appliedKeys.length, appliedMarkers: verified ? appliedKeys : null, pendingApplied, verified, pending, staging,
    committedRetention: value.global?.retention ?? null, pendingRetention: pending?.retention ?? null, problems: blocking };
}

let domainValidatorPromise;
async function loadDomainSchemaValidator() {
  if (!domainValidatorPromise) {
    domainValidatorPromise = import('./domain-storage.js')
      .then((module) => module.evolutionDomainSpec?.global?.schema ?? null)
      .catch(() => null);
  }
  return domainValidatorPromise;
}

/**
 * The one verification of a domain aggregate, shared by the diagnostic check
 * and by the offline staging repair.
 *
 * Parsing the document as JSON proves nothing about its shape, and the staging
 * cleanup deletes directories: an aggregate this build cannot validate cannot
 * prove any staging directory unreferenced. `verified` is therefore true only
 * when every check ran and passed - including the runtime global schema, so an
 * unavailable validator leaves the aggregate unverified rather than clean. A
 * `parsed` whose JSON did not parse carries no value and fails the unit checks
 * below, exactly like any other damaged aggregate.
 */
async function verifyDomainAggregate(parsed) {
  const value = parsed.value || {};
  const problems = [];
  if (value.unit?.name !== 'evolution_domain') problems.push(`unit name is ${JSON.stringify(value.unit?.name)}`);
  if (!Number.isInteger(value.unit?.version)) problems.push('unit version is not an integer');
  if (value.global?.schema !== 1) problems.push(`global schema is ${JSON.stringify(value.global?.schema)} (expected 1)`);
  const applied = value.global?.applied ?? {};
  const badMacs = Object.keys(applied).filter((id) => !HEX.test(String(applied[id])));
  if (badMacs.length > 0) problems.push(`${badMacs.length} applied marker(s) are not hex digests`);
  let schemaErrors = null;
  let schemaChecked = false;
  const advisory = [];
  if (problems.length === 0) {
    const validator = await loadDomainSchemaValidator();
    if (validator) {
      schemaChecked = true;
      try {
        const check = validator.safeParse(value.global);
        if (!check.success) schemaErrors = check.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      } catch (error) {
        // The runtime schema projects a value through JSON before validating it,
        // so a document missing a required nested object makes the validator
        // throw instead of returning issues. Either way the aggregate did not
        // verify; it must never escape as "clean" or crash the diagnostic.
        schemaErrors = [{ path: '', message: String(error?.message || error) }];
      }
    } else {
      advisory.push('runtime domain schema validator unavailable; structural checks only');
    }
  }
  return { value, problems, schemaErrors, advisory, verified: problems.length === 0 && schemaChecked && !((schemaErrors?.length ?? 0) > 0) };
}

/**
 * The runtime module that owns the domain archive lock, loaded lazily: the doctor
 * must still run when its dependencies are missing, and every caller treats an
 * unavailable module as "cannot interpret", never as "clear".
 *
 * The lock protocol itself (`withArchiveLock`, and the read-only
 * `inspectArchiveLock` the report uses) is imported from that same module instead
 * of being re-implemented here: one protocol creates the bare-pid entry, reclaims
 * only an entry it inspected and refuses a live owner, and a doctor with its own
 * copy would put a second protocol on the same path.
 */
let domainStoragePromise;
async function loadDomainStorage() {
  if (!domainStoragePromise) domainStoragePromise = import('./domain-storage.js').catch(() => null);
  return domainStoragePromise;
}

function dockyardMemoryCheck(paths, parsed) {
  const legacyState = path.join(paths.dockyardDir, 'state.json');
  if (!parsed) return;
  const mem = parsed.value?.evolution;
  if (parsed.error || !mem) return;
  const collections = Object.keys(mem).filter((key) => Array.isArray(mem[key]));
  const counts = Object.fromEntries(collections.map((key) => [key, mem[key].length]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    id: 'state.dockyard-legacy', category: 'state', level: LEVEL.OK,
    summary: `Preserved Dockyard aggregate is readable (${total} record(s)); it is only loaded when domainSeed is explicitly enabled.`,
    evidence: { legacyState, schema: mem.schema ?? null, counts },
  };
}

async function diagnoseMigration(report, paths) {
  const manifestStat = statSafe(paths.migrationManifestPath);
  const staging = fs.existsSync(path.dirname(paths.dataRoot))
    ? fs.readdirSync(path.dirname(paths.dataRoot)).filter((name) => name.startsWith(`${path.basename(paths.dataRoot)}.migration-`)).sort()
    : [];
  const lockFiles = fs.existsSync(path.dirname(paths.dataRoot))
    ? fs.readdirSync(path.dirname(paths.dataRoot)).filter((name) => name === `${path.basename(paths.dataRoot)}.migration.lock`)
    : [];
  if (!manifestStat) {
    if (staging.length > 0 || lockFiles.length > 0) {
      addCheck(report, {
        id: 'migration.manifest', category: 'migration', level: LEVEL.DEGRADED,
        summary: 'A data import was staged but never published; the destination may still be empty.',
        evidence: { dataRoot: paths.dataRoot, staging, lockFiles, manifest: null },
        remediation: 'Inspect the staged directory: it holds the only copy of the import until the manifest exists. Re-run scripts/import-evolution-data.mjs to publish or remove the stage after publishing.',
        recoverable: false,
      });
      return { staging, manifest: null };
    }
    addCheck(report, {
      id: 'migration.manifest', category: 'migration', level: LEVEL.OK,
      summary: 'No legacy data import recorded; the data root started empty.',
      evidence: { dataRoot: paths.dataRoot, manifest: null, staging: [] },
    });
    return { staging, manifest: null };
  }
  const parsed = readJsonSafe(paths.migrationManifestPath);
  if (parsed.error) {
    addCheck(report, {
      id: 'migration.manifest', category: 'migration', level: LEVEL.BLOCKED,
      summary: 'migration-manifest.json is unreadable, so import provenance cannot be trusted.',
      evidence: { manifestPath: paths.migrationManifestPath, error: String(parsed.error.message || parsed.error) },
      remediation: 'Restore the manifest from a backup; without it a repeat import refuses to run or merge.',
      recoverable: false,
    });
    return { staging, manifest: null };
  }
  const manifest = parsed.value || {};
  const problems = [];
  if (manifest.schema !== 1) problems.push(`unsupported manifest schema ${JSON.stringify(manifest.schema)}`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) problems.push('manifest files list is missing or empty');
  if (!HEX64.test(String(manifest.importId || ''))) problems.push('manifest importId is missing or not a sha256');
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const recomputed = digest(JSON.stringify(files
    .map((file) => ({ target: file.target, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => String(left.target).localeCompare(String(right.target)))));
  if (manifest.importId && recomputed !== manifest.importId) problems.push('importId does not match the recorded file list (tampered or duplicated import)');
  const missingTargets = [];
  const evidenceChanges = [];
  const immutable = files.filter((file) => typeof file.target === 'string' && file.target.startsWith('legacy-source/'));
  for (const file of files) {
    if (typeof file.target !== 'string') { problems.push('manifest contains a file entry without a target'); continue; }
    const target = path.join(paths.dataRoot, file.target);
    const stat = statSafe(target);
    if (!stat) { missingTargets.push(file.target); continue; }
    const isImmutableSource = file.target.startsWith('legacy-source/');
    if (isImmutableSource && HEX64.test(String(file.sha256 || ''))) {
      const actual = digest(fs.readFileSync(target));
      if (actual !== file.sha256) evidenceChanges.push(file.target);
    }
  }
  if (missingTargets.length > 0) problems.push(`${missingTargets.length} imported file(s) missing from the data root`);
  if (evidenceChanges.length > 0) problems.push(`${evidenceChanges.length} immutable import evidence file(s) changed`);
  // Everything the manifest records has now been checked. The staged import
  // directory is the *source* of the publish, so removing it is only safe when
  // every recorded target is present and every immutable evidence file still
  // matches its digest; otherwise the staged copy may be the last copy of the
  // data the manifest names, and offering "cleanup" would destroy it.
  const verifiedPublish = problems.length === 0;
  if (staging.length > 0 && verifiedPublish) problems.push(`${staging.length} staged import directorie(s) remain after the publish`);
  const level = evidenceChanges.length > 0 || problems.some((problem) => problem.includes('importId') || problem.includes('schema')) ? LEVEL.BLOCKED : problems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK;
  const repair = staging.length > 0 && verifiedPublish
    ? {
      id: 'migration-staging-cleanup',
      safe: true,
      description: `Remove ${staging.length} staged import directorie(s) after verifying the published data root matches the recorded manifest.`,
    }
    : undefined;
  addCheck(report, {
    id: 'migration.manifest', category: 'migration', level,
    summary: problems.length === 0
      ? `Legacy import ${String(manifest.importId).slice(0, 12)}… verified: ${files.length} recorded file(s), immutable evidence intact.`
      : `Legacy import has ${problems.length} problem(s): ${problems.join('; ')}.`,
    evidence: {
      manifestPath: paths.migrationManifestPath,
      importId: manifest.importId ?? null,
      importedAt: manifest.importedAt ?? null,
      files: files.length,
      immutableEvidence: immutable.length,
      missingTargets,
      evidenceChanges,
      staging,
      problems,
      idempotentRepeat: 'a repeat import returns already-imported and never overwrites evolved data',
    },
    remediation: problems.length > 0
      ? 'Do not re-import over this root: adjust or restore the recorded provenance first. A repeat import refuses to merge different source content.'
      : undefined,
    recoverable: Boolean(repair),
    ...(repair ? { repair } : {}),
  });
  return { staging, manifest };
}

function inspectPromotionJournal(report, paths) {
  const journalPath = path.join(paths.promotionStateDir, 'journal.json');
  const stateDirStat = statSafe(paths.promotionStateDir);
  const lock = inspectLock(paths.promotionLockPath);
  if (!stateDirStat) {
    addCheck(report, {
      id: 'promotion.journal', category: 'promotion', level: LEVEL.OK,
      summary: 'No promotion journal: no promotion is in progress.',
      evidence: { promotionStateDir: paths.promotionStateDir, state: 'not-executed', lock },
      recoverable: false,
    });
    return { state: 'not-executed', lock };
  }
  if (!statSafe(journalPath)) {
    const leftovers = fs.readdirSync(paths.promotionStateDir).sort();
    // The runtime refuses to start on this same state (`promotionStateKnown()`
    // in the orchestrator), so reporting anything below `blocked` here would
    // tell the operator the plugin still runs when it does not.
    addCheck(report, {
      id: 'promotion.journal', category: 'promotion', level: LEVEL.BLOCKED,
      summary: 'A promotion state directory exists without a journal; the plugin refuses to start rather than guess at its state.',
      evidence: { promotionStateDir: paths.promotionStateDir, state: 'state-unknown', leftovers, lock },
      remediation: 'Move the directory aside after copying it. The doctor will not delete promotion state it cannot classify.',
      recoverable: false,
    });
    return { state: 'state-unknown', lock };
  }
  const parsed = readJsonSafe(journalPath);
  if (parsed.error) {
    addCheck(report, {
      id: 'promotion.journal', category: 'promotion', level: LEVEL.BLOCKED,
      summary: 'The promotion journal is unreadable; the plugin refuses to start rather than guess.',
      evidence: { journalPath, state: 'state-unknown', error: String(parsed.error.message || parsed.error), lock },
      remediation: 'Inspect journal.json and its backups/ directory by hand; the doctor never repairs an unreadable journal.',
      recoverable: false,
    });
    return { state: 'state-unknown', lock };
  }
  const journal = parsed.value || {};
  const { state, phase, boundary } = classifyPromotionJournal(journal, paths);
  // A rollback intent is written before any target is touched. Only ENOENT
  // means "none started"; an unreadable or malformed one is a live scene the
  // runtime refuses, so the doctor must not call the same state a normal canary.
  let rollbackIntent = { state: 'absent' };
  let rollbackReceipt = { state: 'absent' };
  if (state === 'canary-observing') {
    const parsedIntent = readJsonSafe(path.join(paths.promotionStateDir, 'rollback-intent.json'));
    if (parsedIntent.error) rollbackIntent = { state: parsedIntent.error?.code === 'ENOENT' ? 'absent' : 'unreadable' };
    else rollbackIntent = classifyRollbackIntent(parsedIntent.value, journal.experimentId);
    if (typeof journal.experimentId === 'string' && journal.experimentId !== '') {
      const receiptPath = path.join(paths.archiveDir, `${journal.experimentId}.evidence.json`);
      let receiptBytes = null;
      try { receiptBytes = fs.statSync(receiptPath).size; }
      catch (error) { rollbackReceipt = { state: error?.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
      if (receiptBytes !== null) {
        const parsedReceipt = readJsonSafe(receiptPath);
        if (parsedReceipt.error) rollbackReceipt = { state: parsedReceipt.error?.code === 'ENOENT' ? 'absent' : 'unreadable' };
        else rollbackReceipt = classifyRollbackReceipt(parsedReceipt.value, journal.experimentId, receiptBytes);
      }
    }
  }

  const base = {
    journalPath, phase: phase ?? null, experimentId: journal.experimentId ?? null, state,
    canary: journal.canary ? { startupVerified: journal.canary.startupVerified === true, observations: Array.isArray(journal.canary.observations) ? journal.canary.observations.length : null, window: journal.canary.healthObservationWindow ?? null } : null,
    records: Array.isArray(journal.records) ? journal.records.length : null,
    rollbackFailures: Array.isArray(journal.rollbackFailures) ? journal.rollbackFailures.length : null,
    lock,
  };
  const descriptors = {
    incomplete: {
      level: LEVEL.DEGRADED,
      summary: `A promotion was interrupted in phase ${phase}; its recorded changes are rolled back from the journal backups on the next start.`,
      remediation: 'Start the plugin (recovery runs before the promoted composition mounts) or run the doctor with --repair.',
      recoverable: true,
      repair: { id: 'promotion-journal-recover', safe: true, requiresRestart: true, description: 'Roll back the interrupted promotion from the journal backups and remove the journal.' },
    },
    'canary-observing': {
      level: LEVEL.DEGRADED,
      summary: `A promotion for ${journal.experimentId} is in canary observation; it is mounted but not yet a stable commit.`,
      remediation: 'Restart the app and advance the canary barrier with evolution_canary_observe, or roll back explicitly. The doctor will not decide for you.',
      recoverable: false,
    },
    'committed-pending-cleanup': {
      level: LEVEL.DEGRADED,
      summary: 'A promotion is committed; its journal cleanup is still pending and is completed on the next start.',
      remediation: 'Start the plugin or run the doctor with --repair to finish the idempotent cleanup.',
      recoverable: true,
      repair: { id: 'promotion-journal-cleanup', safe: true, requiresRestart: true, description: 'Delete the committed promotion journal state directory (backups are no longer needed).' },
    },
    'rollback-failed': {
      level: LEVEL.BLOCKED,
      summary: 'A promotion rollback failed and its journal is preserved; the composition and the promoted code may disagree.',
      remediation: `Resolve by hand: inspect ${paths.promotionStateDir} and its backups, restore the composition row and plugin directory, then remove the journal only after the on-disk state matches a known-good commit.`,
      recoverable: false,
    },
    'state-unknown': {
      level: LEVEL.BLOCKED,
      summary: boundary ? `The promotion journal recovery is refused: ${boundary}.` : `The promotion journal has an unrecognised phase (${JSON.stringify(phase)}); refusal is the safe answer.`,
      remediation: 'Inspect journal.json by hand. The doctor does not move promotion state it cannot classify.',
      recoverable: false,
    },
  };
  const receiptBlocked = state === 'canary-observing' && (rollbackReceipt.state === 'unreadable' || rollbackReceipt.state === 'invalid');
  const receiptReady = state === 'canary-observing' && rollbackReceipt.state === 'ready';
  const intentBlocked = !receiptReady && state === 'canary-observing' && (rollbackIntent.state === 'unreadable' || rollbackIntent.state === 'invalid');
  const intentPending = !receiptReady && state === 'canary-observing' && rollbackIntent.state === 'ready';
  const descriptor = receiptReady
    ? {
      level: LEVEL.DEGRADED,
      summary: `A rollback for ${journal.experimentId} completed and its durable receipt is present; only journal cleanup and conclusion/archive reconciliation remain.`,
      remediation: 'Restart the entry to finish journal cleanup and publish the regression conclusion. Do not advance the canary.',
      recoverable: false,
    }
    : intentPending
      ? {
        level: LEVEL.DEGRADED,
        summary: `A rollback for ${journal.experimentId} was started and must be completed before the canary can advance; the next start re-runs the idempotent rollback and writes its durable receipt.`,
        remediation: 'Restart the entry to finish the rollback, journal cleanup and regression conclusion. Do not advance the canary.',
        recoverable: false,
      }
      : descriptors[state];
  const blocked = receiptBlocked || intentBlocked;
  addCheck(report, {
    id: 'promotion.journal', category: 'promotion', level: blocked ? LEVEL.BLOCKED : descriptor.level,
    summary: receiptBlocked
      ? 'A rollback receipt for this canary is unreadable or invalid; recovery refuses to guess and the plugin will not advance it.'
      : intentBlocked
        ? 'A rollback was started for this canary but its intent is unreadable or invalid; recovery refuses to guess and the plugin will not advance it.'
        : descriptor.summary,
    evidence: { ...base, boundary: boundary || null, rollbackIntent: rollbackIntent.state, rollbackReceipt: rollbackReceipt.state },
    remediation: receiptBlocked
      ? `Inspect ${paths.archiveDir}/${journal.experimentId}.evidence.json by hand; restore a complete readable receipt or preserve the journal and intent for manual recovery. The doctor never rewrites rollback state.`
      : intentBlocked
        ? `Inspect ${paths.promotionStateDir}/rollback-intent.json by hand; restore a complete readable copy or move the journal aside after copying it. The doctor never rewrites rollback state.`
        : descriptor.remediation,
    recoverable: blocked ? false : descriptor.recoverable,
    ...(descriptor.repair && !blocked ? { repair: descriptor.repair } : {}),
  });
  return { state, phase, lock, journal: base };
}

/**
 * The promotion-journal boundary rule is owned by the orchestrator, so this
 * report and recovery refuse exactly the same journals for the same reason.
 * Re-exported here for the doctor's report consumers.
 */
export { checkJournalBoundary };


/**
 * A source-free summary of a js-yaml failure: a fixed category plus the parser's
 * own position.
 *
 * The parser's `message` embeds a snippet of the document, and its `reason` is
 * not structural either - it quotes the source in more than one place:
 * `unknown tag !<the tag the document wrote>`,
 * `unidentified alias "name"`, and even
 * `tag name cannot contain such characters: <the tag's text>` (which is plain
 * words, so a character class cannot separate it from a structural reason).
 * This report is rendered into the CLI output and the `evolution_doctor` tool
 * result, so no part of the reason is repeated: the category is fixed and the
 * position is the parser's own. An operator reads the file the position names.
 */
function yamlErrorSummary(error) {
  let position = '';
  try {
    const mark = error?.mark;
    if (mark && Number.isInteger(mark.line) && Number.isInteger(mark.column)) {
      position = ` (line ${mark.line + 1}, column ${mark.column + 1})`;
    }
  } catch {
    // A hostile parser object cannot make the report fail or echo itself.
  }
  return `invalid YAML${position}`;
}

async function diagnosePromotedComposition(report, paths, { promotion }) {
  const stat = statSafe(paths.compositionPath);
  const rows = [];
  const problems = [];
  if (stat) {
    let entries;
    const yaml = await loadYaml();
    if (!yaml) {
      addCheck(report, {
        id: 'promotion.composition', category: 'promotion', level: LEVEL.NOT_EVALUATED,
        summary: 'promoted.cordis.yml exists but no YAML parser is reachable, so its rows were not verified.',
        evidence: { compositionPath: paths.compositionPath, reason: 'js-yaml is unavailable (expected as a bundle dependency)' },
        remediation: 'Reinstall the bundle so its declared js-yaml dependency is present, then re-run the doctor.',
      });
      return { rows: [], problems: ['yaml parser unavailable'] };
    }
    try {
      entries = yaml.load(fs.readFileSync(paths.compositionPath, 'utf8'));
    } catch (error) {
      // A YAML parser error message embeds an excerpt of the document that failed
      // to parse. This report is rendered into the CLI output and the
      // `evolution_doctor` tool result, so the excerpt would put configuration
      // values (including credentials the redaction rules do not recognize in a
      // positional line) on the model's side of the boundary. Only the parser's
      // own reason and position are kept.
      addCheck(report, {
        id: 'promotion.composition', category: 'promotion', level: LEVEL.BLOCKED,
        summary: 'promoted.cordis.yml is not valid YAML; the official Include cannot mount it.',
        evidence: { compositionPath: paths.compositionPath, error: yamlErrorSummary(error) },
        remediation: 'Restore the last-good composition from the promotion journal backups (or remove the file if no promotion is committed).',
        recoverable: false,
      });
      return { rows: [], problems: ['invalid yaml'] };
    }
    if (!Array.isArray(entries)) problems.push('composition is not an entry list');
    for (const entry of Array.isArray(entries) ? entries : []) {
      const name = typeof entry?.name === 'string' ? entry.name : null;
      const row = { id: entry?.id ?? null, name, disabled: entry?.disabled === true };
      if (typeof entry?.id !== 'string') problems.push('a row has no id');
      else if (!ROW_ID.test(entry.id)) problems.push(`row id ${entry.id} is not an Evolution-managed id`);
      if (!name) problems.push(`row ${row.id} has no module name`);
      else {
        let urlFile = null;
        try { urlFile = fileURLToPath(name); } catch { problems.push(`row ${row.id} name is not a file URL`); }
        if (urlFile) {
          if (!PROMOTED_ROW_FILE.test(urlFile)) problems.push(`row ${row.id} does not point at lib/index.js`);
          if (path.resolve(urlFile) !== urlFile || !urlFile.startsWith(`${path.resolve(paths.pluginRoot)}${path.sep}`)) {
            problems.push(`row ${row.id} points outside the promoted plugin root`);
          } else {
            const pluginDir = path.dirname(path.dirname(urlFile));
            const packageJson = readJsonSafe(path.join(pluginDir, 'package.json'));
            if (!statSafe(urlFile)) problems.push(`row ${row.id} module file is missing`);
            if (packageJson.error) problems.push(`row ${row.id} plugin package.json is missing or unreadable`);
            row.plugin = { dir: pluginDir, present: Boolean(statSafe(urlFile)), manifest: packageJson.value?.name ?? null };
          }
        }
      }
      rows.push(row);
    }
  }
  const orphanDirs = [];
  if (fs.existsSync(paths.pluginRoot)) {
    const referenced = new Set(rows.map((row) => row.plugin?.dir).filter(Boolean));
    for (const name of fs.readdirSync(paths.pluginRoot).sort()) {
      const dir = path.join(paths.pluginRoot, name);
      if (statSafe(dir)?.isDirectory() && !referenced.has(dir)) orphanDirs.push(name);
    }
  }
  if (!stat && orphanDirs.length > 0) problems.push(`${orphanDirs.length} promoted plugin directorie(s) exist with no composition row`);
  const level = problems.some((problem) => problem.includes('outside') || problem.includes('missing') || problem.includes('not a file URL') || problem.includes('invalid yaml') || problem.includes('not an Evolution-managed id'))
    ? LEVEL.BLOCKED
    : problems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK;
  addCheck(report, {
    id: 'promotion.composition', category: 'promotion', level,
    summary: rows.length === 0
      ? 'No promoted composition: no durable capability is mounted.'
      : problems.length === 0
        ? `Promoted composition mounts ${rows.length} durable row(s), all inside the promoted plugin root.`
        : `Promoted composition has ${problems.length} problem(s): ${problems.join('; ')}.`,
    evidence: { compositionPath: paths.compositionPath, present: Boolean(stat), rows, orphanDirs, problems, journalState: promotion?.state ?? null },
    remediation: problems.length > 0
      ? 'Remove or restore the offending row. An unresolved row prevents the plugin from mounting its promoted composition.'
      : undefined,
    recoverable: false,
  });
  return { rows, problems, orphanDirs };
}

function diagnosePointer(report, paths, composition, { promotion, migration } = {}) {
  const stat = statSafe(paths.evolutionPath);
  if (!stat) {
    addCheck(report, {
      id: 'promotion.pointer', category: 'promotion', level: LEVEL.OK,
      summary: 'No EVOLUTION.md pointer yet.',
      evidence: { evolutionPath: paths.evolutionPath, present: false },
    });
    return;
  }
  const text = fs.readFileSync(paths.evolutionPath, 'utf8');
  const pluginMatch = /durable capability:\s*(\S+)\s*\(([^)]+)\)/.exec(text);
  const rowMatch = /rollback: remove (?:the )?composition row\s+([A-Za-z0-9_-]+)/.exec(text) || /remove composition row\s+([A-Za-z0-9_-]+)/.exec(text);
  const rows = composition?.rows || [];
  const pointerRow = rowMatch?.[1] ?? null;
  const knownRow = pointerRow ? rows.some((row) => row.id === pointerRow) : null;
  const pointerDir = pluginMatch?.[2] ? path.resolve(expandHome(pluginMatch[2])) : null;
  const outsideCurrentRoot = Boolean(pointerDir) && !pointerDir.startsWith(`${path.resolve(paths.pluginRoot)}${path.sep}`);
  const migrationBoundary = Array.isArray(migration?.manifest?.boundaries)
    && migration.manifest.boundaries.some((boundary) => /promoted code/i.test(String(boundary)));
  const intentionallyInactive = Boolean(pointerRow) && knownRow === false && rows.length === 0 && outsideCurrentRoot && migrationBoundary
    && (promotion?.state === 'not-executed' || !promotion?.state);
  const problems = [];
  if (!intentionallyInactive) {
    if (pointerRow && knownRow === false) problems.push(`EVOLUTION.md points at row ${pointerRow}, which the composition does not contain`);
    if (pluginMatch && pointerDir && !statSafe(pointerDir) && !outsideCurrentRoot) problems.push('the recorded durable capability directory is missing');
  }
  addCheck(report, {
    id: 'promotion.pointer', category: 'promotion', level: problems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
    summary: problems.length > 0
      ? `The durable capability pointer is stale: ${problems.join('; ')}.`
      : intentionallyInactive
        ? `The pointer names legacy capability ${pointerRow}, intentionally not mounted (recorded migration boundary: no legacy promoted code execution).`
        : pointerRow ? `The durable capability pointer names row ${pointerRow}${knownRow ? ', which the composition mounts' : ''}.` : 'EVOLUTION.md has no promotion pointer.',
    evidence: { evolutionPath: paths.evolutionPath, pointerRow, knownRow, pointerDir, outsideCurrentRoot, migrationBoundary, intentionallyInactive, problems, bytes: stat.size },
    remediation: problems.length > 0 ? 'Finish or roll back the promotion so the pointer and the composition agree; the pointer is evidence, not authority.' : undefined,
    recoverable: false,
  });
}

/**
 * Cross-entry publication and per-profile activation state.
 *
 * This is the reporting side of the shared-plugin contract: a record is only
 * shareable when the stable evidence published it, the on-disk source still has
 * the digest the record names, the recorded host identity still matches the
 * running one, and each consumer reports what it actually did. Nothing here
 * activates, revokes or repairs anything; the check is read-only by design.
 */
/** Consumer state is operator-adjacent JSON; never assume every row is shaped. */
function sharingPluginRows(state) {
  return consumerActivationRows(state);
}

/** Bounded host facts from a consumer's last start; never borrow another host. */
function sharingConsumerHost(host) {
  if (!host || typeof host !== 'object' || Array.isArray(host)) return null;
  const text = (value) => (typeof value === 'string' && value ? value.slice(0, 80) : null);
  return {
    profile: text(host.profile),
    dsh: text(host.dsh),
    cordis: text(host.cordis),
    include: text(host.include),
    node: text(host.node),
    capturedAt: text(host.capturedAt),
    verifiedAt: text(host.verifiedAt),
  };
}

// Statuses a consumer can write for a published record. Anything else is not
// proof of activation: the unified review classifies it as unverified and asks
// for a restart, so doctor must do the same instead of silently skipping it.
const SHARED_ACTIVATION_STATUSES = new Set([
  'active', 'failed', 'skipped-incompatible', 'skipped-invalid', 'skipped-unapproved',
  'pending-revalidation', 'pending-restart', 'disabled', 'missing',
]);

function unverifiedActivationReason(row) {
  const status = typeof row?.status === 'string' && row.status ? row.status.slice(0, 40) : 'unknown';
  return `consumer-${status}`;
}

async function diagnoseSharing(report, paths, { observedHost = null, observedHostReason = null, profile = null } = {}) {
  const shared = { dataRoot: paths.dataRoot, pluginRoot: paths.pluginRoot };
  const index = await readSharedIndex(shared);
  const disable = await readDisableState(shared);
  // Within this one read-only pass the revocation table is fixed. Build its
  // membership once: every per-record and per-row check below must read the
  // same table, and a repeated linear scan would make the whole check O(N^2).
  // The plugin id is kept as the exact value the table holds: `disable` is only
  // shape-validated via `String(entry.pluginId)`, so an entry can carry a
  // non-string (for example an array) that string interpolation would fold onto
  // a real id and turn into a revocation the baseline never honoured. `Set.has`
  // compares like the baseline's `===` for every value a record id can hold.
  const disabledByProfile = new Map();
  for (const entry of Array.isArray(disable.entries) ? disable.entries : []) {
    if (!disabledByProfile.has(entry.profile)) disabledByProfile.set(entry.profile, new Set());
    disabledByProfile.get(entry.profile).add(entry.pluginId);
  }
  const isDisabled = (id, profile) => disabledByProfile.get(profile)?.has(id) ?? false;
  if (index.status === 'absent') {
    // An absent index does not imply an empty runtime: a consumer that mounted a
    // record before its index file was removed still reports an ACTIVE row. A
    // server-side stale mount is not proof of a healthy runtime even though the
    // unified review stops at `absent` here, so doctor must not call the same
    // scene healthy just because it stopped reading at the index.
    const consumerStates = {};
    for (const profile of SHARED_CONSUMER_PROFILES) consumerStates[profile] = await readConsumerState(shared, profile);
    // One bounded projection per profile for this pass; every consumer of the
    // rows (orphans below and the evidence block) reads the same snapshot.
    const rowsByProfile = Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, sharingPluginRows(consumerStates[profile].state)]));
    const orphanMounts = SHARED_CONSUMER_PROFILES.flatMap((profile) =>
      rowsByProfile[profile]
        .filter((row) => row.status === 'active')
        .map((row) => ({ profile, id: row.id })));
    if (orphanMounts.length === 0) {
      addCheck(report, {
        id: 'promotion.sharing', category: 'promotion', level: LEVEL.OK,
        summary: 'No promoted plugin is published to other entries; every promotion stays Desktop-only.',
        evidence: { status: 'absent', indexPath: sharingPaths(shared).indexPath },
        recoverable: false,
      });
    } else {
      addCheck(report, {
        id: 'promotion.sharing', category: 'promotion', level: LEVEL.DEGRADED,
        summary: `No publication index exists, but ${orphanMounts.length} plugin(s) are still mounted in a consumer; restart the affected entry to drop them.`,
        evidence: { status: 'absent', indexPath: sharingPaths(shared).indexPath, orphanMounts,
          consumers: Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, {
            status: consumerStates[profile].status,
            plugins: rowsByProfile[profile].map((row) => ({ id: row.id, status: row.status, reason: row.reason })),
          }])) },
        remediation: 'Restart the consumer that still reports an active mount; deleting published.json does not unmount a running plugin.',
        recoverable: false,
      });
    }
    return { index, disable, records: [], consumers: consumerStates };
  }
  if (index.status === 'invalid' || index.status === 'unreadable') {
    addCheck(report, {
      id: 'promotion.sharing', category: 'promotion', level: LEVEL.BLOCKED,
      summary: 'The shared plugin publication index is unreadable or malformed, so no plugin is authorized to any entry.',
      evidence: { status: index.status, indexPath: sharingPaths(shared).indexPath, invalid: index.invalid, error: index.error ?? null },
      remediation: 'Restore a complete published.json from its last good copy, or remove it to keep every promotion Desktop-only; consumers refuse an unreadable index by design.',
      recoverable: false,
    });
    return { index, disable, records: [], consumers: {} };
  }
  const records = [];
  const problems = [];
  const hostMismatches = [];
  const consumerStates = {};
  for (const profile of SHARED_CONSUMER_PROFILES) {
    consumerStates[profile] = await readConsumerState(shared, profile);
  }
  // All row and record lookups below operate on these same snapshots. Building
  // them once per pass avoids materialising the same filtered array eight times
  // and turns the per-row record search into an O(1) map lookup.
  const rowsByProfile = Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, sharingPluginRows(consumerStates[profile].state)]));
  const rowIdsByProfile = Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, new Set(rowsByProfile[profile].map((row) => row.id))]));
  const consumerHostByProfile = Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, sharingConsumerHost(consumerStates[profile].state?.host)]));
  const restartPendingByProfile = Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [
    profile,
    consumerStates[profile].status === 'ok' && consumerNeedsRestart(index.updatedAt, consumerStates[profile].state),
  ]));
  // An unreadable or malformed consumer state cannot prove that the consumer
  // ever activated a published record: the unified review reports that profile
  // as unverified (consumer-state-invalid / consumer-state-unreadable) and asks
  // for a restart. The review only visits approved, non-revoked records, so a
  // damaged state for a profile with no such record is historical and must not
  // manufacture a restart request here.
  const unverifiedConsumers = SHARED_CONSUMER_PROFILES
    .filter((profile) => index.records.some((record) => record.approvedProfiles.includes(profile) && !isDisabled(record.id, profile)))
    .filter((profile) => consumerStates[profile].status !== 'ok' && consumerStates[profile].status !== 'absent')
    .map((profile) => ({ profile, status: consumerStates[profile].status }));
  for (const record of index.records) {
    let source = 'verified';
    try {
      const plugin = await readPromotedPlugin(shared, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });
      if (plugin.sourceSha256 !== record.sourceSha256) { source = 'source-digest-mismatch'; problems.push({ id: record.id, reason: 'source-digest-mismatch' }); }
      else if (plugin.manifestSha256 !== record.manifestSha256) { source = 'manifest-digest-mismatch'; problems.push({ id: record.id, reason: 'manifest-digest-mismatch' }); }
    } catch (error) {
      source = 'source-unusable';
      problems.push({ id: record.id, reason: 'source-unusable' });
    }
    const diagnosedProfile = profile ?? observedHost?.profile ?? null;
    const hostCompatibleByProfile = {};
    for (const profile of record.approvedProfiles) {
      const state = consumerStates[profile];
      const consumerHost = consumerHostByProfile[profile];
      const row = rowsByProfile[profile].find((entry) => entry.id === record.id) ?? null;
      const restartPending = restartPendingByProfile[profile];
      // Revocation does not move the index timestamp. An old refusal for a
      // revoked profile is historical, not a current host mismatch; only an
      // active mount still needs the existing unload restart.
      if (isDisabled(record.id, profile)) {
        const stillMounted = row?.status === 'active';
        hostCompatibleByProfile[profile] = {
          ok: null, reason: stillMounted ? 'active-after-revocation' : 'operator-disabled',
          status: stillMounted ? 'restart-required' : 'disabled',
          consumerHost, verifiedHost: record.host, restartPending: false,
        };
        continue;
      }
      if (state.status !== 'ok') {
        hostCompatibleByProfile[profile] = {
          ok: null, reason: `consumer-state-${state.status}`, status: 'unverified',
          consumerHost, verifiedHost: record.host, restartPending: false,
        };
        continue;
      }
      // Round 4 precedence: a consumer that has not observed this index has not
      // evaluated the current record on its host. Its old refusal is cleared by
      // a restart, not by declaring a current host mismatch.
      if (restartPending) {
        hostCompatibleByProfile[profile] = {
          ok: null, reason: 'index-changed-since-consumer-start', status: 'restart-required',
          consumerHost, verifiedHost: record.host, restartPending: true,
        };
        continue;
      }
      if (!row) {
        hostCompatibleByProfile[profile] = {
          ok: null, reason: 'no-activation-record', status: 'restart-required',
          consumerHost, verifiedHost: record.host, restartPending: false,
        };
        continue;
      }
      // `reset` deliberately keeps the previous host receipt until the next
      // start. It is a restart request, not a fresh compatibility evaluation.
      if (row.status === 'pending-restart') {
        hostCompatibleByProfile[profile] = {
          ok: null, reason: row.reason || 'operator-reset', status: 'restart-required',
          consumerHost, verifiedHost: record.host, restartPending: false,
        };
        continue;
      }
      if (!consumerHost?.dsh) {
        hostCompatibleByProfile[profile] = {
          ok: null, reason: row.reason ?? 'consumer-host-unknown', status: row.status,
          consumerHost, verifiedHost: record.host, restartPending: false,
        };
        continue;
      }
      const consumerVerdict = hostCompatible(record.host, consumerHost);
      const hostFailure = row.status === 'failed' && isConsumerHostFailure(row);
      const refusal = !hostFailure && (row.status === 'pending-revalidation' || row.status === 'failed' || row.status === 'skipped-incompatible');
      const mismatch = source === 'verified'
        && (disable.status === 'ok' || disable.status === 'absent')
        && refusal && consumerVerdict.ok === false;
      const effectiveOk = hostFailure || (row.status === 'active' && consumerVerdict.ok === false) ? null : consumerVerdict.ok;
      hostCompatibleByProfile[profile] = {
        ok: effectiveOk,
        reason: mismatch ? consumerVerdict.reason : row.status === 'active'
          ? (effectiveOk === null ? 'active-consumer-host-unverified' : null)
          : row.reason ?? consumerVerdict.reason,
        status: mismatch ? 'pending-revalidation' : row.status,
        consumerHost, verifiedHost: record.host, restartPending: false,
      };
      if (mismatch) {
        const detail = {
          profile, recordId: record.id, sourceSha256: record.sourceSha256, reason: consumerVerdict.reason,
          consumerHost, verifiedHost: record.host,
        };
        hostMismatches.push(detail);
        problems.push({ id: record.id, profile, reason: consumerVerdict.reason });
      }
    }
    // `hostCompatible` describes the diagnosed profile when it is approved.
    // Other profiles keep their own verdict beside it, so a Web mismatch can
    // never make the same record look compatible to Web merely because the
    // doctor process resolved a different CLI candidate.
    const profileVerdict = diagnosedProfile ? hostCompatibleByProfile[diagnosedProfile] : null;
    const hasProfileVerdict = Boolean(profileVerdict);
    const consumerVerdicts = Object.values(hostCompatibleByProfile);
    const mismatchedConsumer = consumerVerdicts.find((verdict) => verdict.ok === false);
    const allConsumersCompatible = consumerVerdicts.length === record.approvedProfiles.length
      && consumerVerdicts.every((verdict) => verdict.ok === true);
    // Only consumer receipts generate sharing compatibility problems. The CLI
    // identity remains in observedHost as evidence; without an approved
    // consumer receipt it must not fabricate a record-level mismatch.
    const attributedVerdict = hasProfileVerdict
      ? profileVerdict
      : mismatchedConsumer
        ? { ok: false, reason: mismatchedConsumer.reason }
        : allConsumersCompatible
          ? { ok: true, reason: null }
          : { ok: null, reason: 'consumer-host-unknown' };
    records.push({
      id: record.id,
      approvedProfiles: record.approvedProfiles,
      source,
      stable: record.stable,
      host: record.host,
      hostCompatible: attributedVerdict.ok,
      hostReason: attributedVerdict.reason,
      hostCompatibleByProfile,
      revalidation: Array.isArray(record.revalidation) ? record.revalidation.length : 0,
    });
  }
  // Validated records have unique ids, so one map replaces every repeated
  // linear search for a consumer row's record in the loops below.
  const recordById = new Map(records.map((record) => [record.id, record]));
  // A per-record validation failure leaves the rest of the index usable, but it
  // is not healthy: the consumer skipped that record and the unified review
  // reports the same scene as blocked. Count it here so the two read-only
  // surfaces agree instead of one saying OK and the other requiring an action.
  for (const invalid of (Array.isArray(index.invalid) ? index.invalid : [])) {
    problems.push({ id: invalid?.id ?? invalid?.pluginId ?? null, reason: invalid?.reason ?? 'invalid-record' });
  }
  const disabled = (disable.entries || []).map((entry) => ({ pluginId: entry.pluginId, profile: entry.profile }));
  const deadConsumers = [];
  const inactiveConsumers = [];
  const unverifiedActivationRows = [];
  const missingConsumerRows = [];
  // A readable index can still omit one record (edited away) or stop approving
  // one profile. A consumer that mounted it before that change keeps running,
  // so the row cannot be skipped as merely historical: only a consumer restart
  // unloads it. This is the same window the absent-index branch already reports.
  const orphanMounts = [];
  for (const profile of SHARED_CONSUMER_PROFILES) {
    const state = consumerStates[profile];
    const rows = rowsByProfile[profile];
    for (const row of rows) {
      const record = recordById.get(row.id);
      if (!record || !record.approvedProfiles.includes(profile)) {
        if (row.status === 'active') {
          orphanMounts.push({ profile, id: row.id, reason: record ? 'profile-not-approved' : 'record-missing' });
        }
        continue;
      }
      // A consumer row written before an operator revoked the profile is
      // historical: the unified review reports the record as disabled now, so
      // doctor must not keep degrading on a stale refusal.
      if (isDisabled(row.id, profile)) continue;
      // A row without a recognized status is not proof of activation: the
      // review classifies it as unverified (consumer-unknown) and requires a
      // restart. Do not fold it into the failed/inactive buckets either.
      if (!SHARED_ACTIVATION_STATUSES.has(row.status)) {
        unverifiedActivationRows.push({ profile, id: row.id, reason: unverifiedActivationReason(row) });
        continue;
      }
      if (row.status === 'failed' || row.status === 'skipped-invalid') {
        deadConsumers.push({ profile, id: row.id, status: row.status, reason: row.reason });
      } else if (row.status === 'skipped-incompatible' || row.status === 'pending-revalidation' || row.status === 'pending-restart'
        || row.status === 'skipped-unapproved' || row.status === 'missing'
        || (row.status === 'disabled' && row.reason !== 'already-mounted' && row.reason !== 'publisher-profile')) {
        // The unified review classifies these as incompatible / pending
        // revalidation / restart-required (or inactive). A consumer that
        // explicitly refuses an approved record is not a healthy publication,
        // even when its source bytes and host facts agree. A disabled row with
        // an already-mounted / publisher-profile reason is historical and stays
        // out of this bucket, matching the review's no-action verdict.
        if ((row.status === 'pending-revalidation' && restartPendingByProfile[profile]) || row.status === 'pending-restart') {
          inactiveConsumers.push({
            profile, id: row.id, status: 'restart-required',
            reason: row.status === 'pending-restart' ? (row.reason || 'operator-reset') : 'index-changed-since-consumer-start',
          });
        } else {
          const mismatch = hostMismatches.find((entry) => entry.profile === profile && entry.recordId === row.id);
          inactiveConsumers.push({
            profile, id: row.id, status: row.status, reason: row.reason ?? null,
            ...(mismatch ? { consumerHost: mismatch.consumerHost, verifiedHost: mismatch.verifiedHost, hostCompatible: false } : {}),
          });
        }
      }
    }
    // A consumer that claims to have observed the current index but has no row
    // for an approved, non-revoked record cannot prove activation either: the
    // unified review reports no-activation-record -> unverified -> restart.
    // An absent (never started) state is deliberately not treated as a missing
    // row; consumerNeedsRestart already covers a state on an older index.
    const observed = state.status === 'ok' ? state.state?.observedIndexUpdatedAt : null;
    if (observed && typeof index.updatedAt === 'string' && observed === index.updatedAt) {
      const rowIds = rowIdsByProfile[profile];
      for (const record of records) {
        if (!record.approvedProfiles.includes(profile) || isDisabled(record.id, profile)) continue;
        if (rowIds.has(record.id)) continue;
        missingConsumerRows.push({ profile, id: record.id });
      }
    }
  }
  // The name-by-name rule lives with the CLI so doctor and the operator commands
  // cannot disagree about which profiles have not loaded the current index.
  const pendingRestartDetailsForReport = pendingRestartDetails(index.updatedAt, records,
    Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, consumerStates[profile].state])),
    disable.entries, disable.status);
  const pendingRestart = [...new Set(pendingRestartDetailsForReport.map((row) => row.profile))];
  const staleProfiles = pendingRestartDetailsForReport.filter((row) => row.reason === 'index-stale').map((row) => row.profile);
  const revokedProfiles = pendingRestartDetailsForReport.filter((row) => row.reason === 'revoked-active-mount').map((row) => row.profile);
  const restoredProfiles = pendingRestartDetailsForReport.filter((row) => row.reason === 'eligibility-restored').map((row) => row.profile);
  const invalidRecords = Array.isArray(index.invalid) ? index.invalid.length : 0;
  // An unreadable or malformed revocation table is a safety condition, not a
  // missing table: consumers refuse every published record in that state (they
  // must not mount something the operator may have disabled). The unified
  // review reports the same scene as blocked/operator-action, so doctor must
  // not call it merely degraded even before a consumer has written a refusal.
  const disableUnreadable = disable.status !== 'ok' && disable.status !== 'absent';
  const blocking = invalidRecords > 0 || records.some((record) => record.source !== 'verified') || disableUnreadable;
  const degraded = !blocking && (problems.length > 0 || deadConsumers.length > 0 || inactiveConsumers.length > 0 || pendingRestart.length > 0 || orphanMounts.length > 0 || unverifiedConsumers.length > 0 || missingConsumerRows.length > 0 || unverifiedActivationRows.length > 0);
  const activeByProfile = Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, rowsByProfile[profile].filter((row) => row.status === 'active').map((row) => row.id)]));
  const orphanSummary = orphanMounts.length > 0
    ? ` ${orphanMounts.length} orphan active mount(s) keep running until the corresponding consumer restarts.`
    : '';
  const orphanRemediation = orphanMounts.length > 0
    ? ' Restart the consumer that still reports an orphan active mount: removing a record from the index or unapproving a profile does not unload a plugin that is already running.'
    : '';
  const unverifiedSummary = unverifiedConsumers.length > 0
    ? ` ${unverifiedConsumers.length} consumer state(s) (${unverifiedConsumers.map((row) => `${row.profile}: ${row.status}`).join(', ')}) are unreadable, so activation cannot be proven; restart the affected consumer(s).`
    : '';
  const unverifiedRemediation = unverifiedConsumers.length > 0
    ? ` Restart the consumer(s) with unreadable state (${unverifiedConsumers.map((row) => row.profile).join(', ')}): activation cannot be proven from that state, and a fresh start is needed to rebuild a trustworthy activation report.`
    : '';
  const missingRowsSummary = missingConsumerRows.length > 0
    ? ` ${missingConsumerRows.length} activation row(s) (${missingConsumerRows.map((row) => `${row.profile}: ${row.id}`).join(', ')}) are missing from consumers that already observed the current index; restart those consumers.`
    : '';
  const missingRowsRemediation = missingConsumerRows.length > 0
    ? ` Restart the consumer(s) missing an activation row (${missingConsumerRows.map((row) => row.profile).join(', ')}): a state that observed the current index without the row cannot prove the published record was activated.`
    : '';
  const unverifiedRowsSummary = unverifiedActivationRows.length > 0
    ? ` ${unverifiedActivationRows.length} activation row(s) have an unrecognized status, so activation cannot be proven; restart the affected consumer(s).`
    : '';
  const unverifiedRowsRemediation = unverifiedActivationRows.length > 0
    ? ` Restart the consumer(s) with an unrecognized activation row status (${unverifiedActivationRows.map((row) => row.profile).join(', ')}): the row cannot prove activation, and a fresh start is needed to rebuild a trustworthy report.`
    : '';
  const pendingRestartSummary = `${staleProfiles.length > 0 ? ` Consumer profile(s) ${staleProfiles.join(', ')} have not loaded the current shared index and still need a restart.` : ''}${revokedProfiles.length > 0 ? ` Consumer profile(s) ${revokedProfiles.join(', ')} still mount a revoked plugin and need a restart to unload it.` : ''}${restoredProfiles.length > 0 ? ` Consumer profile(s) ${restoredProfiles.join(', ')} still record an operator-disabled plugin that is eligible again and need a restart to load it.` : ''}`;
  const pendingRestartRemediation = [consumerRestartGuidance(staleProfiles), consumerRevocationGuidance(revokedProfiles), consumerEligibilityGuidance(restoredProfiles)]
    .filter(Boolean).map((text) => ` ${text}`).join('');
  const describeSharingHost = (host) => {
    const text = (value) => (typeof value === 'string' && value ? value.slice(0, 80) : 'unknown');
    return [
      `DSH ${text(host?.dsh)}`,
      `Cordis ${text(host?.cordis)}`,
      `Include ${text(host?.include)}`,
      `Node ${text(host?.node)}`,
    ].join(', ');
  };
  const hostUnavailableConsumers = deadConsumers.filter((row) => isConsumerHostFailure(row));
  const hostUnavailableSummary = hostUnavailableConsumers.length > 0
    ? ` Consumer host startup is unavailable for ${hostUnavailableConsumers.map((row) => `${row.profile}: ${row.reason}`).join(', ')}; these failures occur before plugin evaluation.`
    : '';
  const hostUnavailableRemediation = hostUnavailableConsumers.length > 0
    ? ` Restore the official Include host capability and restart ${hostUnavailableConsumers.map((row) => row.profile).join(', ')}; revalidating plugin bytes cannot repair an entry that failed before plugin evaluation.`
    : '';
  const hostMismatchSummary = hostMismatches.length > 0
    ? ` Current-index consumer host mismatch: ${hostMismatches.map((row) =>
      `${row.profile} runs ${describeSharingHost(row.consumerHost)} but ${row.recordId} was verified on ${describeSharingHost(row.verifiedHost)}`).join('; ')}.`
    : '';
  const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  const hostMismatchRemediation = hostMismatches.length > 0
    ? hostMismatches.map((row) =>
      ` For ${row.profile}, choose one convergence path: align ${row.profile} with the verified host (${describeSharingHost(row.verifiedHost)}) and restart it; or, if ${row.profile} must stay on ${describeSharingHost(row.consumerHost)}, verify the exact same source bytes (${row.sourceSha256}) on that real host and adopt the evidence against this report's data root with dsh-evolution-shared revalidate --evidence <evidence.json> --data-root ${shellQuote(paths.dataRoot)}. Adoption replaces the record's single verified host for every approved profile; restart affected consumers afterward, and align any profile that must remain on the previous verified host. A restart alone cannot clear a current-index host mismatch.`).join('')
    : '';
  let summary = blocking
    ? disableUnreadable
      ? `Shared plugins are published, but the per-profile revocation table is ${disable.status}; consumers refuse every record.`
      : invalidRecords > 0
        ? `The publication index contains ${invalidRecords} malformed record(s) that consumers skip.`
        : 'A published plugin record disagrees with its on-disk source; consumers refuse it.'
    : degraded
      ? `Shared plugins are published, with ${problems.length} compatibility problem(s), ${deadConsumers.length} failed and ${inactiveConsumers.length} inactive consumer activation(s).`
      : `${index.records.length} verified stable plugin(s) are published for ${SHARED_CONSUMER_PROFILES.join('/')}.`;
  let remediation = blocking
    ? disableUnreadable
      ? `The per-profile revocation table (disabled.json) is ${disable.status} and consumers refuse every record. Restore it from a backup, or deliberately remove the file to mean "no per-profile revocations" (that re-enables every revoked plugin for ACP/Web); the doctor never rewrites it.`
      : invalidRecords > 0
        ? 'Restore a valid record by re-promoting it through Desktop; a malformed row cannot be revoked by the shared-plugins CLI, and deleting it from published.json is undone by the startup reconciliation.'
        : 'A published record and its source disagree (edited, moved or tampered plugin). Re-promote through Desktop, or revoke it persistently with dsh-evolution-shared disable; consumers refuse mismatched bytes.'
    : degraded
      ? 'Read the per-profile consumer state: revalidation is required after a host change, a failed activation stays skipped until it is reset, and a publish after the entry started needs a restart (HMR stays off).'
      : undefined;
  if (hostUnavailableConsumers.length > 0) {
    summary += hostUnavailableSummary;
    remediation = (remediation ?? '') + hostUnavailableRemediation;
  }
  if (hostMismatches.length > 0) {
    summary += hostMismatchSummary;
    remediation = (remediation ?? '') + hostMismatchRemediation;
  }
  if (orphanMounts.length > 0) {
    summary += orphanSummary;
    remediation = (remediation ?? '') + orphanRemediation;
  }
  if (unverifiedConsumers.length > 0) {
    summary += unverifiedSummary;
    remediation = (remediation ?? '') + unverifiedRemediation;
  }
  if (missingConsumerRows.length > 0) {
    summary += missingRowsSummary;
    remediation = (remediation ?? '') + missingRowsRemediation;
  }
  if (unverifiedActivationRows.length > 0) {
    summary += unverifiedRowsSummary;
    remediation = (remediation ?? '') + unverifiedRowsRemediation;
  }
  if (pendingRestart.length > 0) {
    summary += pendingRestartSummary;
    remediation = (remediation ?? '') + pendingRestartRemediation;
  }
  addCheck(report, {
    id: 'promotion.sharing', category: 'promotion',
    level: blocking ? LEVEL.BLOCKED : degraded ? LEVEL.DEGRADED : LEVEL.OK,
    summary,
    evidence: {
      indexPath: sharingPaths(shared).indexPath,
      status: index.status,
      orphanMounts,
      unverifiedConsumers,
      unverifiedActivationRows,
      missingConsumerRows,
      disableStatus: disable.status,
      ...(blocking && disableUnreadable ? { blockingReason: `disable-state-${disable.status}` } : {}),
      updatedAt: index.updatedAt,
      records,
      invalidRecords: index.invalid,
      disabled,
      consumers: Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => [profile, {
        status: consumerStates[profile].status,
        host: consumerHostByProfile[profile],
        updatedAt: consumerStates[profile].state?.updatedAt ?? null,
        observedIndexUpdatedAt: consumerStates[profile].state?.observedIndexUpdatedAt ?? null,
        active: activeByProfile[profile],
        plugins: rowsByProfile[profile].map((row) => ({ id: row.id, status: row.status, reason: row.reason })),
      }])),
      problems,
      deadConsumers,
      inactiveConsumers,
      hostMismatches,
      pendingRestart,
      pendingRestartDetails: pendingRestartDetailsForReport,
      observedHost,
      observedHostReason,
    },
    remediation,
    recoverable: false,
  });
  return { index, disable, records, consumers: consumerStates };
}

/**
 * The read-only usage projection is the durable answer to "was a published
 * capability actually used". A missing, stale, legacy-coverage or incomplete
 * projection is a named degraded fact with the same supplement the review
 * reports. This check only reads the small projection: it never scans a session
 * log, starts a timer, relaxes a retirement gate or changes a published record.
 */
async function diagnoseUsage(report, paths, { index = null } = {}) {
  const dataRoot = paths?.dataRoot ?? paths?.presetDir;
  if (typeof dataRoot !== 'string' || dataRoot === '') {
    addCheck(report, {
      id: 'promotion.usage', category: 'promotion', level: LEVEL.NOT_EVALUATED,
      summary: 'The usage projection cannot be located without a data root.',
      evidence: { reason: 'data-root-unavailable' },
    });
    return;
  }
  const loaded = await readUsageProjection({ dataRoot });
  const recordIds = Array.isArray(index?.records) ? index.records.map((record) => record?.id) : [];
  const verdict = classifyUsageProjection({
    usage: loaded.usage, status: loaded.evidence.status, evidence: loaded.evidence, recordIds,
  });
  const publishedRecordCount = recordIds.length;
  // An absent projection measures nothing: every in-scope record is unknown,
  // not "zero absent from the projection".
  const absentCoverage = loaded.evidence.status === 'absent' && publishedRecordCount > 0;
  const home = typeof paths.dshHome === 'string' && paths.dshHome !== '' ? paths.dshHome : null;
  // A damaged file can carry arbitrary text in capturedAt. Only a parsed,
  // normalised timestamp is safe to put into a diagnostic report.
  const capturedMs = typeof loaded.evidence.capturedAt === 'string'
    ? Date.parse(loaded.evidence.capturedAt) : Number.NaN;
  const evidence = {
    usagePath: sharingPaths(paths).usagePath,
    status: loaded.evidence.status,
    reason: loaded.evidence.reason ?? null,
    coverage: loaded.evidence.coverage ?? null,
    capturedAt: Number.isFinite(capturedMs) ? new Date(capturedMs).toISOString() : null,
    ageDays: loaded.evidence.ageDays ?? null,
    complete: loaded.evidence.complete ?? null,
    recordsComplete: loaded.evidence.recordsComplete ?? null,
    stale: loaded.evidence.stale ?? null,
    publishedRecordCount,
    missingRecordCount: verdict.missingRecordCount ?? 0,
    ...(absentCoverage ? { unmeasuredRecordCount: publishedRecordCount } : {}),
    issues: verdict.issues,
  };
  // An absent projection is harmless when nothing is published; a projection
  // that exists but is damaged is not, even with an empty index.
  if (publishedRecordCount === 0 && (verdict.ok || loaded.evidence.status === 'absent')) {
    addCheck(report, {
      id: 'promotion.usage', category: 'promotion', level: LEVEL.OK,
      summary: 'No published stable plugin is in scope, so no usage projection is required.',
      evidence,
      recoverable: false,
    });
    return;
  }
  if (verdict.ok) {
    addCheck(report, {
      id: 'promotion.usage', category: 'promotion', level: LEVEL.OK,
      summary: `${publishedRecordCount} published stable plugin(s) have a current, complete usage projection; value tiers can distinguish real use from measured zero.`,
      evidence,
      recoverable: false,
    });
    return;
  }
  // A projection that exists but is damaged or incomplete stays degraded even
  // when the publication index is empty: silently reporting ok would hide the
  // very file the operator is being asked to repair.
  const supplement = usageProjectionRemediation({ dataRoot, home });
  const texts = verdict.issues.map((issue) => USAGE_PROJECTION_ISSUE_TEXT[issue] ?? issue);
  // With no publication index the producer cannot produce a converging
  // projection (its scan is definitionally incomplete), so copying the command
  // would replace the damaged file with another degraded one. The convergent
  // step is to restore the index, or remove the damaged projection and accept
  // the honest absent state.
  // A valid but empty index is a normal Desktop-only installation: running the
  // producer does converge. Only a missing/damaged index needs restoration
  // before a scan can produce a meaningful projection.
  const indexUsable = index?.status === 'ok';
  const remediation = publishedRecordCount === 0 && !indexUsable
    ? 'Restore the shared publication index from its last good copy and re-run doctor; if this entry is intentionally Desktop-only, remove the damaged usage.json (the doctor never rewrites it) so promotion.usage returns to ok.'
    : supplement.command
      ? `Generate the template with \`${supplement.templateCommand}\`, review each record, then write with \`${supplement.command}\`. ${supplement.assessments.note}`
        + (publishedRecordCount === 0
          ? ' With no published record in scope, removing the residual usage.json is the convergent alternative: promotion.usage then returns to ok without a scan.'
          : '')
      : 'Run the documented capability-usage producer and review each record before supplying --assessments.';
  const missing = verdict.missingRecordCount ?? 0;
  const scope = publishedRecordCount === 0
    ? 'no published record currently needs it'
    : absentCoverage
      ? `all ${publishedRecordCount} published record(s) in scope are unmeasured because no projection exists for this data root`
      : `${publishedRecordCount} published record(s) in scope, ${missing} absent from the projection;`
        + ' only the zero counts of the affected records cannot be confirmed as measured until the explicit audit writes a current projection';
  addCheck(report, {
    id: 'promotion.usage', category: 'promotion', level: LEVEL.DEGRADED,
    summary: `${texts.join('; ')}; ${scope}. Recorded positive counts remain facts.`,
    evidence,
    remediation,
    recoverable: false,
  });
}

function diagnoseRuntime(report, { ctx, live, promotionRuntime, domainStorage, registeredNames, config }) {
  if (!live || !ctx) {
    addCheck(report, {
      id: 'runtime.capabilities', category: 'runtime', level: LEVEL.NOT_EVALUATED,
      summary: 'Live Cordis capabilities are not observable outside a running host session.',
      evidence: { reason: 'cli mode without a live context' },
      remediation: 'Run the evolution_doctor tool inside a session for live capability and registration verification.',
    });
    addCheck(report, {
      id: 'runtime.registration', category: 'runtime', level: LEVEL.NOT_EVALUATED,
      summary: 'Live tool registration is not observable outside a running host session.',
      evidence: { reason: 'cli mode without a live context', expected: EVOLUTION_TOOL_NAMES },
      remediation: 'Run the evolution_doctor tool inside a session, or check host.composition for the loader entries.',
    });
    addCheck(report, {
      id: 'runtime.internal-api', category: 'runtime', level: LEVEL.NOT_EVALUATED,
      summary: 'Introspection probes were not exercised outside a running host session.',
      evidence: { reason: 'cli mode without a live context' },
    });
    return null;
  }
  const serviceStates = REQUIRED_RUNTIME_SERVICES.map((name) => {
    let implementation;
    try { implementation = typeof ctx.get === 'function' ? ctx.get(name) : undefined; } catch { implementation = undefined; }
    const direct = ctx[name];
    return { name, bound: Boolean(implementation), present: Boolean(direct ?? implementation), type: typeof (direct ?? implementation) };
  });
  const missingServices = serviceStates.filter((service) => !service.present).map((service) => service.name);
  const methodChecks = [
    { path: 'ctx.tools.register', ok: typeof ctx.tools?.register === 'function' },
    { path: 'ctx.tools.get', ok: typeof ctx.tools?.get === 'function' },
    { path: 'ctx.tools.schemas', ok: typeof ctx.tools?.schemas === 'function' },
    { path: 'ctx.on', ok: typeof ctx.on === 'function' },
    { path: 'ctx.effect', ok: typeof ctx.effect === 'function' },
    { path: 'ctx.systemPrompt.section', ok: typeof ctx.systemPrompt?.section === 'function' },
    { path: 'promotionRuntime.verify', ok: typeof promotionRuntime?.verify === 'function' },
    { path: 'promotionRuntime.refresh', ok: typeof promotionRuntime?.refresh === 'function' },
    { path: 'promotionRuntime.health', ok: typeof promotionRuntime?.health === 'function' },
    { path: 'domainStorage.query', ok: typeof domainStorage?.query === 'function' },
    { path: 'domainStorage.flush', ok: typeof domainStorage?.flush === 'function' },
  ];
  const missingMethods = methodChecks.filter((check) => !check.ok).map((check) => check.path);
  const blocking = missingServices.length > 0 || missingMethods.some((method) => !method.startsWith('ctx.effect') && !method.startsWith('promotionRuntime.health'));
  const degraded = missingMethods.includes('ctx.effect') || missingMethods.includes('promotionRuntime.health');
  addCheck(report, {
    id: 'runtime.capabilities', category: 'runtime', level: blocking ? LEVEL.BLOCKED : degraded ? LEVEL.DEGRADED : LEVEL.OK,
    summary: blocking
      ? `Missing runtime capability: ${[...missingServices, ...missingMethods].join(', ')}.`
      : degraded
        ? `Runtime is functional with reduced capability: ${missingMethods.join(', ')}.`
        : 'Every required host service and runtime method is present.',
    evidence: { services: serviceStates, methods: methodChecks, missingServices, missingMethods, startupDrift: config?.startupDrift === true, promotionAdapter: config?.promotionAdapter ?? null },
    remediation: blocking ? 'The host does not provide the surface this bundle injects. Install the supported DSH version before enabling the plugin.' : undefined,
    recoverable: false,
  });

  const names = Array.isArray(registeredNames) ? registeredNames : null;
  const toolStates = EVOLUTION_TOOL_NAMES.map((name) => {
    let definition = null;
    try { definition = typeof ctx.tools?.get === 'function' ? ctx.tools.get(name) : null; } catch { definition = null; }
    const inList = names ? names.includes(name) : null;
    return { name, visible: Boolean(definition), hasExecute: typeof definition?.execute === 'function', recorded: inList };
  });
  const missingTools = toolStates.filter((tool) => !tool.visible || tool.hasExecute === false).map((tool) => tool.name);
  addCheck(report, {
    id: 'runtime.registration', category: 'runtime', level: missingTools.length > 0 ? LEVEL.BLOCKED : LEVEL.OK,
    summary: missingTools.length > 0
      ? `${missingTools.length} expected tool(s) are not registered: ${missingTools.join(', ')}.`
      : `All ${EVOLUTION_TOOL_NAMES.length} expected tools resolve in the live registry.`,
    evidence: { expected: EVOLUTION_TOOL_NAMES, tools: toolStates, missingTools },
    remediation: missingTools.length > 0 ? 'A partially registered surface means the plugin apply() failed midway; read the host log and restart.' : undefined,
    recoverable: false,
  });

  const probes = probeSurfaces(ctx, { promotionRuntime });
  const unavailable = probes.unavailable;
  const privateUsed = probes.probes.filter((probe) => probe.kind === SURFACE_PRIVATE && probe.ok).map((probe) => probe.api);
  addCheck(report, {
    id: 'runtime.internal-api', category: 'runtime', level: unavailable.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
    summary: unavailable.length > 0
      ? `${unavailable.length} required introspection surface(s) are unavailable; introspection degrades to partial facts.`
      : `All ${probes.probes.filter((probe) => probe.required).length} required introspection surfaces answered on this host (${probes.publicReplacements.length} private/undocumented surface(s) have a recorded public replacement).`,
    evidence: {
      probes: probes.probes,
      unavailable,
      advisoryUnavailable: probes.advisoryUnavailable,
      privateSurfacesUsed: privateUsed,
      privateSurfacesWithoutReplacement: probes.privateSurfacesWithoutReplacement,
      publicReplacements: probes.publicReplacements,
      undocumentedSurfaces: probes.undocumentedSurfaces,
      note: 'Classification comes from the shipped packages: public = exported member with a documented contract; undocumented = public runtime property without one; private = underscore-prefixed and skipped by cordis when it resolves context members. Every required surface is probed individually and reported, so an upgrade cannot silently turn introspection into partial facts. lib/cordis-compat.js is the single source of truth for this list and for the readers that use it.',
    },
    recoverable: false,
  });
  return { serviceStates, toolStates, probes: probes.probes };
}

function diagnoseLegacyAndLimits(report, { config }) {
  addCheck(report, {
    id: 'compat.legacy-adapters', category: 'compat', level: LEVEL.OK,
    summary: `Legacy adapters are isolated and disabled in the bundle path (startupDrift=${config?.startupDrift === true}).`,
    evidence: {
      startupDrift: config?.startupDrift === true,
      legacyAdapter: 'lib/compat/legacy-startup-drift.js',
      legacyDefaults: 'overridden by storageConfig/resolveEvolutionPaths; only reachable from a standalone caller without configuration',
      dataMigrationScript: 'scripts/import-evolution-data.mjs (explicit source arguments only)',
    },
    ...(config?.startupDrift === true ? { remediation: 'The legacy startup-drift adapter is enabled by configuration and reads an external DSH tree; disable it unless it is required.' } : {}),
  });
  addCheck(report, {
    id: 'capabilities.known-limits', category: 'capabilities', level: LEVEL.OK,
    summary: `${KNOWN_DEGRADED_CAPABILITIES.length} documented, non-blocking capability limit(s) apply to this build.`,
    evidence: { degradedCapabilities: KNOWN_DEGRADED_CAPABILITIES.map((entry) => entry.id) },
  });
}

// ---------------------------------------------------------------------------
// repair
// ---------------------------------------------------------------------------

export async function applyRepairs(repairs, options = {}) {
  const paths = options.paths || resolveEvolutionPaths(options);
  const applied = [];
  const only = options.only ? new Set(options.only) : null;
  const domainStorage = await loadDomainStorage();
  const inspectArchiveLock = typeof domainStorage?.inspectArchiveLock === 'function' ? domainStorage.inspectArchiveLock : null;
  for (const repair of repairs) {
    if (only && !only.has(repair.id)) continue;
    if (repair.safe !== true) { applied.push({ id: repair.id, status: 'skipped', detail: 'not declared safe' }); continue; }
    if (options.live === true && repair.requiresRestart === true) {
      applied.push({ id: repair.id, status: 'skipped', detail: 'restart required: the live composition is mounted, so the startup recovery path owns this repair' });
      continue;
    }
    try {
      if (repair.id === 'promotion-journal-recover' || repair.id === 'promotion-journal-cleanup') {
        const lock = inspectLock(paths.promotionLockPath);
        // The archive lock is read by the runtime's classifier, not by the
        // promotion directory-lock reader. When the module that owns it is
        // unavailable the lock state cannot be proven, so the recovery is not
        // attempted rather than guessed.
        const archiveLock = inspectArchiveLock ? inspectArchiveLock(paths.domainArchiveLockPath) : null;
        if (lock.active || archiveLock === null || archiveLock.ownerAlive) {
          applied.push({ id: repair.id, status: 'skipped', detail: archiveLock === null
            ? 'the archive lock classifier is unavailable, so the lock state cannot be proven; stop the application and re-run the doctor'
            : 'a live process holds the promotion/archive lock; stop the application first' });
          continue;
        }
        const outcome = await recoverInterruptedPromotion({ ...paths, promotionRuntime: undefined });
        applied.push({ id: repair.id, status: outcome.recovered === false && outcome.status === 'canary-pending' ? 'skipped' : 'applied', detail: outcome.status });
        continue;
      }
      if (repair.id === 'event-bridge-trim-partial-tail') {
        // The plan was derived from an earlier read of this file. Re-read the
        // bytes now and re-establish the exact condition it was offered under:
        // one malformed record, and that record is the unterminated last line.
        // A tail that became a complete record in the meantime is a trusted
        // event, and truncating it would delete evidence.
        const before = fs.readFileSync(paths.eventBridgePath, 'utf8');
        const inspected = inspectJsonLines(before);
        const matchesPlan = inspected.truncatedTail
          && inspected.invalid.length === 1
          && inspected.invalid[0].line === inspected.lineCount;
        if (!matchesPlan) {
          applied.push({
            id: repair.id, status: 'skipped',
            detail: `the file no longer matches the plan: ${inspected.invalid.length} malformed record(s) of ${inspected.lineCount} line(s), unterminated tail ${inspected.truncatedTail}; nothing was written`,
          });
          continue;
        }
        const cut = before.lastIndexOf('\n');
        if (cut < 0) { applied.push({ id: repair.id, status: 'skipped', detail: 'no complete line to keep' }); continue; }
        const kept = before.slice(0, cut + 1);
        // The trim publishes with rename, which gives the log a new generation.
        // Two floor states make that unsafe: a truncation still pending (the new
        // inode would look like it had run), and a completed floor whose tail
        // digest covered bytes the trim is about to remove. Use the same
        // pending-first priority as startup recovery, and prove that the kept
        // bytes still begin with the exact tail the floor authenticates.
        try {
          const key = readEventBridgeKey(paths);
          const document = JSON.parse(fs.readFileSync(paths.domainGlobalPath, 'utf8'));
          const floor = document?.global?.pending?.retention ?? document?.global?.retention ?? null;
          if (floor?.log && key.state === 'valid') {
            const status = inspectEventLogFloor({ file: paths.eventBridgePath, key: key.text, floor }).status;
            if (status === 'deferred') {
              applied.push({ id: repair.id, status: 'skipped',
                detail: 'a committed retention truncation is still pending; let the next start complete it before trimming an unterminated tail' });
              continue;
            }
            if (status === 'already-truncated') {
              const tailBytes = Buffer.from(kept, 'utf8').subarray(0, Math.min(floor.log.tail.bytes, Buffer.byteLength(kept)));
              if (digestLogBytes(key.text, tailBytes) !== floor.log.tail.digest) {
                applied.push({ id: repair.id, status: 'skipped',
                  detail: 'the retained tail would no longer match the committed retention floor; nothing was written' });
                continue;
              }
            }
          }
        } catch {
          // An unreadable floor or key cannot prove either condition; the
          // ordinary trim preconditions still decide this repair.
        }
        const temp = `${paths.eventBridgePath}.${process.pid}.trim.tmp`;
        fs.writeFileSync(temp, kept, { mode: 0o600 });
        const handle = fs.openSync(temp, 'r');
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
        // This is a check-then-act boundary, not an atomic one: the writers of
        // the bridge file hold no lock, so the bytes can change at any moment.
        // Re-reading here removes an append that landed while the replacement
        // was prepared; an append that lands between this read and the rename
        // below can still be dropped (documented in README/COMPATIBILITY).
        const after = fs.readFileSync(paths.eventBridgePath, 'utf8');
        if (after !== before) {
          fs.rmSync(temp, { force: true });
          applied.push({
            id: repair.id, status: 'skipped',
            detail: `the file changed while the replacement was prepared (${before.length} -> ${after.length} byte(s)); nothing was written`,
          });
          continue;
        }
        fs.renameSync(temp, paths.eventBridgePath);
        applied.push({ id: repair.id, status: 'applied', detail: `re-verified the unterminated tail, then kept ${kept.length} verified bytes and dropped ${before.length - kept.length} byte(s) of unterminated tail` });
        continue;
      }
      if (repair.id === 'domain-stale-lock') {
        // The removal is the runtime's own protocol, imported from the module
        // that owns it: `withArchiveLock` reclaims exactly the entry its acquire
        // inspected (pinned by device, inode and bytes) and releases only the
        // entry it wrote. The previous raw `unlinkSync` here deleted by path and
        // could remove a lock a live writer acquired between the diagnostic read
        // and the unlink.
        //
        // Both details are written from what this call can actually observe. An
        // error from the acquire does NOT prove nothing was removed - the
        // acquire can reclaim an old entry and then fail while creating or
        // writing its own, and an entry inside its settle window can be reclaimed
        // during this very call - so the failure text says the maintenance did
        // not complete and that the doctor cannot tell what the path now holds.
        // A completed acquire does not prove the release succeeded either:
        // `withArchiveLock` returns the callback's value and drops the fenced
        // release's result, so the success text says only that the protocol ran.
        const withArchiveLock = typeof domainStorage?.withArchiveLock === 'function' ? domainStorage.withArchiveLock : null;
        if (!withArchiveLock) {
          applied.push({ id: repair.id, status: 'skipped', detail: 'the archive lock implementation is unavailable, so the runtime acquire/release protocol was not run; re-run the doctor once it loads' });
          continue;
        }
        let entered = false;
        try {
          await withArchiveLock(paths.domainArchiveLockPath, async () => { entered = true; return null; });
        } catch (error) {
          if (!entered) {
            applied.push({ id: repair.id, status: 'skipped', detail: `the archive lock maintenance did not complete (${error?.code || error?.message || error}); the protocol may have reclaimed an entry before failing, so the doctor cannot tell from this error what the lock path now holds - re-run the doctor` });
            continue;
          }
          throw error;
        }
        applied.push({ id: repair.id, status: 'applied', detail: 'the runtime acquire/release protocol completed' });
        continue;
      }
      if (repair.id === 'domain-orphan-staging') {
        // The plan was derived from a read taken before any lock existed, and a
        // writer can acquire the archive lock, stage its transaction and publish
        // the pending record after that read. The removal therefore runs under the
        // same lock a port takes and re-reads the pending record inside it; the
        // lock entry is released only while it is still the one this repair wrote.
        const withArchiveLock = typeof domainStorage?.withArchiveLock === 'function' ? domainStorage.withArchiveLock : null;
        if (!withArchiveLock) {
          applied.push({ id: repair.id, status: 'skipped', detail: 'the domain archive lock implementation is unavailable; staging left untouched' });
          continue;
        }
        let removed;
        let entered = false;
        try {
          removed = await withArchiveLock(paths.domainArchiveLockPath, async () => {
            entered = true;
            // The pending record is re-read inside the lock, and it is verified
            // with the same checks the diagnostic reports: a document that parses
            // but does not validate cannot prove any staging directory
            // unreferenced, so it removes nothing.
            const aggregate = await verifyDomainAggregate(readJsonSafe(paths.domainGlobalPath));
            if (!aggregate.verified) return null;
            const pending = aggregate.value.global?.pending ?? null;
            const deleted = [];
            for (const name of fs.existsSync(paths.domainStagingDir) ? fs.readdirSync(paths.domainStagingDir) : []) {
              if (!STAGE_NAME.test(name)) continue;
              if (pending && pending.stage === name) continue;
              fs.rmSync(path.join(paths.domainStagingDir, name), { recursive: true, force: true });
              deleted.push(name);
            }
            return deleted;
          });
        } catch (error) {
          // The acquire failing means the callback never ran, so nothing was
          // removed: a live writer, a lock entry this protocol cannot interpret
          // and a lock still settling are all reported, never bypassed.
          if (!entered) {
            applied.push({ id: repair.id, status: 'skipped', detail: `the domain archive lock could not be taken (${error?.code || error?.message || error}); staging left untouched` });
            continue;
          }
          throw error;
        }
        if (removed === null) {
          applied.push({ id: repair.id, status: 'skipped', detail: 'the domain aggregate does not fully validate as schema 1, so no staging directory can be proven unreferenced; nothing was removed' });
          continue;
        }
        applied.push({ id: repair.id, status: removed.length > 0 ? 'applied' : 'skipped', detail: removed.length > 0 ? `removed ${removed.join(', ')}` : 'nothing left to remove' });
        continue;
      }
      if (repair.id === 'migration-staging-cleanup') {
        const parsed = readJsonSafe(paths.migrationManifestPath);
        const manifest = parsed.value;
        if (!manifest || !HEX64.test(String(manifest.importId || ''))) { applied.push({ id: repair.id, status: 'skipped', detail: 'no verified manifest to compare against' }); continue; }
        // Re-verify the published data root right before deleting the source
        // directories: the report that offered this repair may be older than the
        // filesystem it described, and a target that disappeared since then makes
        // the staged copy the only remaining evidence.
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const unverified = files.find((file) => {
          if (typeof file?.target !== 'string') return true;
          const target = path.join(paths.dataRoot, file.target);
          const stat = statSafe(target);
          if (!stat) return true;
          if (!file.target.startsWith('legacy-source/') || !HEX64.test(String(file.sha256 || ''))) return false;
          return digest(fs.readFileSync(target)) !== file.sha256;
        });
        if (unverified) { applied.push({ id: repair.id, status: 'skipped', detail: 'the published data root no longer matches the recorded manifest; staged import left in place' }); continue; }
        const removed = [];
        const parent = path.dirname(paths.dataRoot);
        const prefix = `${path.basename(paths.dataRoot)}.migration-`;
        for (const name of fs.readdirSync(parent)) {
          if (!name.startsWith(prefix)) continue;
          fs.rmSync(path.join(parent, name), { recursive: true, force: true });
          removed.push(name);
        }
        applied.push({ id: repair.id, status: removed.length > 0 ? 'applied' : 'skipped', detail: removed.length > 0 ? `removed ${removed.join(', ')}` : 'nothing left to remove' });
        continue;
      }
      applied.push({ id: repair.id, status: 'skipped', detail: 'no implementation for this repair id' });
    } catch (error) {
      applied.push({ id: repair.id, status: 'failed', detail: String(error?.message || error) });
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

/**
 * Collect a full diagnostic report. Read-only unless `repair: true`.
 */
/**
 * The live host identity the sharing check compares against.
 *
 * A packaged Desktop/ACP/Web host boots through its bundled
 * `@deepseek-ai/dsh-desktop-host` entry inside `app.asar`, and the host CLI is
 * an Electron launcher rather than a Node-resolvable `@deepseek-ai/dsh` bin.
 * The CLI resolution above therefore stays unknown there; without this fallback
 * the doctor would compare the record against `{dsh: null, ...}` and report a
 * false `host-version-mismatch` for a plugin that is actually active on the
 * running host. The fallback uses the same entry/resource rules as the runtime
 * applicability reader and only fills fields the CLI resolution could not prove.
 */
export function observedHostFacts({ dsh = null, cordis = null, include = null, runningEntry = null, packageRoot = null, profile = null } = {}) {
  const facts = { dsh, cordis, include };
  if (facts.dsh && facts.cordis && facts.include) {
    return { ...facts, node: process.version, profile };
  }
  // Supplying any one fact means the caller is describing a specific host;
  // borrowing the missing ones from this process could mix two installations
  // into a false "compatible" verdict. Only an explicit packageRoot may fill
  // the gaps then. With no facts at all, the process identity remains the
  // fallback that keeps packaged-host reports meaningful.
  const describesHost = Boolean(facts.dsh || facts.cordis || facts.include);
  let detected = null;
  if (packageRoot) {
    detected = {
      dsh: readPackageVersionFile(path.join(packageRoot, 'package.json')),
      cordis: packageVersionFromHostRoot(packageRoot, '@deepseek-ai/cordis'),
      include: packageVersionFromHostRoot(packageRoot, '@deepseek-ai/cordis-plugin-include'),
    };
  } else if (!describesHost) {
    try {
      detected = detectHostIdentity({ refresh: true, entries: runningEntry ? [runningEntry] : null });
    } catch {
      detected = null;
    }
  }
  return {
    dsh: facts.dsh ?? detected?.dsh ?? null,
    cordis: facts.cordis ?? detected?.cordis ?? null,
    include: facts.include ?? detected?.include ?? null,
    node: process.version,
    profile,
  };
}

export async function collectDiagnostics(options = {}) {
  const paths = options.paths || resolveEvolutionPaths(options);
  const packageRoot = options.packageRoot || PACKAGE_ROOT;
  const manifest = readPeerRange(packageRoot);
  const report = createReport({ mode: options.live && options.ctx ? 'host' : 'cli', plugin: { name: manifest.name, version: manifest.version, packageRoot } });
  // The startup repair publishes a bounded outcome into the in-session doctor
  // report. It is not a new check: no health verdict is inferred from it.
  const recoveredRollbacks = options.config?.rollbackConclusionReconciliation?.rollbacks;
  if (Array.isArray(recoveredRollbacks) && recoveredRollbacks.length > 0) {
    const reconciliation = options.config.rollbackConclusionReconciliation;
    report.rollbackRecovery = {
      status: reconciliation.status,
      recovered: recoveredRollbacks.slice(0, 20).map((row) => ({ experimentId: row.experimentId, state: row.state })),
      published: reconciliation.published,
      duplicates: reconciliation.duplicates,
      truncated: recoveredRollbacks.length > 20,
    };
  }

  if (options.home) addCheck(report, { id: 'plugin.home', category: 'plugin', level: LEVEL.OK, summary: `Diagnosing DSH home ${paths.dshHome}.`, evidence: { dshHome: paths.dshHome, dataRoot: paths.dataRoot, profile: options.profile ?? null } });

  diagnosePackage(report, { packageRoot });
  await diagnosePatch(report, { packageRoot });
  await diagnosePlatformVersion(report, paths);
  const profileDir = options.profileDir || (options.profile && options.dshHome ? path.join(paths.dshHome, 'profiles', options.profile) : null);
  const installedInfo = diagnoseInstalled(report, { profileDir, packageRoot, profileCandidates: options.profileCandidates });
  diagnoseProfileVersionSkew(report, { dshHome: paths.dshHome, profileCandidates: options.profileCandidates });
  const host = diagnoseHostCli(report, { dshHome: paths.dshHome, profile: options.profile ?? null, profileDir, cliPath: options.cliPath, peers: manifest.peers, probe: options.probe, runningEntry: options.runningEntry ?? null });
  diagnoseRuntime(report, {
    ctx: options.ctx, live: options.live === true, promotionRuntime: options.promotionRuntime,
    domainStorage: options.domainStorage, registeredNames: options.registeredNames, config: options.config,
  });
  diagnoseLegacyAndLimits(report, { config: options.config });

  // The domain-storage module owns the archive lock protocol; the doctor loads it
  // lazily and, when it is unavailable, reports the lock as uninspectable (and
  // blocked if an entry exists) instead of re-implementing the interpretation.
  const domainStorageModule = await loadDomainStorage();
  const inspectArchiveLock = typeof domainStorageModule?.inspectArchiveLock === 'function' ? domainStorageModule.inspectArchiveLock : null;
  const key = readEventBridgeKey(paths);
  diagnoseDataRoot(report, paths, { live: options.live === true && Boolean(options.ctx), installed: Boolean(installedInfo?.installedVersion), inspectArchiveLock });
  await diagnoseMemory(report, paths);
  const legacyState = await diagnoseArchives(report, paths);
  const bridgeScan = {};
  const bridge = await diagnoseEventBridge(report, paths, {
    // The verification path only ever sees a valid key; data.key owns the rest.
    key: key.state === 'valid' ? key.text : null,
    keyValid: key.state === 'valid',
    keyState: key.state,
    ...resolveTrustedWriter(options.config, host?.composition?.writer),
  }, { scanState: bridgeScan });
  const migration = await diagnoseMigration(report, paths);
  const domain = await diagnoseDomain(report, paths, { migration: migration.manifest, inspectArchiveLock });
  addEventBridgeCapacityEvidence(bridgeScan, domain);
  diagnoseRetentionFloor(report, paths, key, domain);
  if (legacyState) addCheck(report, legacyState);
  // Both checks below run after the reads they need: the domain aggregate is
  // already parsed (so the 2.3 MB document is not read a second time) and the
  // bridge's record count is already known.
  diagnoseOwnership(report, paths);
  diagnoseEventBridgeKey(report, paths, {
    key,
    bridge,
    domain: domain ? { applied: domain.applied, pendingApplied: domain.pendingApplied, verified: domain.verified } : null,
  });
  const promotion = inspectPromotionJournal(report, paths);
  const composition = await diagnosePromotedComposition(report, paths, { promotion });
  diagnosePointer(report, paths, composition, { promotion, migration });
  const moduleVersion = (name) => host?.hostModules?.find((module) => module.name === name)?.version ?? null;
  // When the selected CLI has no Node-resolvable package root its module
  // versions come from the same manifests that identified the CLI. Missing
  // fields stay null rather than borrowing this process's peer dependencies.
  const selectedHostFacts = host?.selected?.hostFacts || null;
  const profileHostAmbiguous = host?.profileHostAmbiguous === true;
  const sharing = await diagnoseSharing(report, paths, {
    observedHost: profileHostAmbiguous ? null : observedHostFacts({
      dsh: selectedHostFacts?.dsh ?? host?.version ?? null,
      cordis: selectedHostFacts?.cordis ?? moduleVersion('@deepseek-ai/cordis'),
      include: selectedHostFacts?.include ?? moduleVersion('@deepseek-ai/cordis-plugin-include'),
      runningEntry: options.runningEntry ?? null,
      packageRoot: host?.selected?.packageRoot ?? null,
      profile: options.profile ?? null,
    }),
    observedHostReason: profileHostAmbiguous ? 'profile-host-ambiguous' : null,
    profile: options.profile ?? null,
  });
  await diagnoseUsage(report, paths, { index: sharing.index });

  return finalize(report);
}

/**
 * Run diagnostics, optionally applying only the repairs marked safe, then
 * re-verify. The second report is the authoritative one; a repeat run must
 * produce zero repairs, which is how idempotency is proven.
 */
export async function runDiagnostics(options = {}) {
  const first = await collectDiagnostics(options);
  const safe = first.repairs.filter((repair) => repair.safe === true);
  if (options.repair !== true || safe.length === 0) return first;
  const paths = options.paths || resolveEvolutionPaths(options);
  const applied = await applyRepairs(safe, { ...options, paths });
  const second = await collectDiagnostics({ ...options, repair: false });
  second.repairsApplied = applied;
  second.previousStatus = first.status;
  second.previousRepairs = first.repairs;
  return second;
}

export function summarize(report) {
  const lines = [];
  lines.push(`dsh-evolution doctor — ${report.status.toUpperCase()}${report.partial ? ' (partial)' : ''}`);
  lines.push(`plugin: ${report.plugin.name}@${report.plugin.version} (${report.mode} mode) at ${report.generatedAt}`);
  lines.push(`checks: ${report.summary.ok} ok, ${report.summary.degraded} degraded, ${report.summary.blocked} blocked, ${report.summary.notEvaluated} not evaluated`);
  if (report.previousStatus) lines.push(`before repair: ${report.previousStatus}`);
  if (report.rollbackRecovery) {
    const names = report.rollbackRecovery.recovered.map((row) => `${row.experimentId} (${row.state})`).join(', ');
    lines.push(`recovered rollback(s): ${names}${report.rollbackRecovery.truncated ? ' …' : ''}`);
  }
  for (const applied of report.repairsApplied || []) lines.push(`repair ${applied.id}: ${applied.status}${applied.detail ? ` (${applied.detail})` : ''}`);
  const byCategory = new Map();
  for (const check of report.checks) {
    if (!byCategory.has(check.category)) byCategory.set(check.category, []);
    byCategory.get(check.category).push(check);
  }
  for (const [category, checks] of byCategory) {
    lines.push(`\n[${category}]`);
    for (const check of checks) {
      const badge = check.level === 'ok' ? 'OK  ' : check.level === 'degraded' ? 'WARN' : check.level === 'blocked' ? 'FAIL' : 'SKIP';
      lines.push(`  ${badge} ${check.id}: ${check.summary}`);
      if (check.level !== 'ok') {
        if (check.recoverable !== undefined) lines.push(`       recoverable: ${check.recoverable}`);
        if (check.evidence && Object.keys(check.evidence).length > 0) lines.push(`       evidence: ${JSON.stringify(check.evidence)}`);
        if (check.remediation) lines.push(`       action: ${check.remediation}`);
        if (check.repair) lines.push(`       repair available: ${check.repair.id} — ${check.repair.description}`);
      }
    }
  }
  if (report.coverage.notEvaluated.length > 0) {
    lines.push('\n[not evaluated]');
    for (const entry of report.coverage.notEvaluated) lines.push(`  SKIP ${entry.id}: ${entry.reason}`);
  }
  lines.push('\n[known degraded capabilities]');
  for (const entry of report.degradedCapabilities || []) lines.push(`  - ${entry.id}: ${entry.impact}`);
  return lines.join('\n');
}

export function exitCodeFor(report) {
  return report.status === 'blocked' ? 2 : report.status === 'degraded' ? 1 : 0;
}
