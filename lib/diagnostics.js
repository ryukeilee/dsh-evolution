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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope, recoverInterruptedPromotion, isUsableMemoryEntry, inspectMemoryText, checkJournalBoundary, classifyPromotionJournal, parseTargetClaim, classifyTargetClaim, TARGET_CLAIM_STATES, redactJsonParseMessage } from './orchestrator.js';
import { eventLogCheckpointPath, validRetentionDocument, inspectEventLogFloor, inspectRetentionContinuity } from './event-log-checkpoint.js';
import { probeSurfaces, SURFACE_PRIVATE } from './cordis-compat.js';
import { inspectArchiveIntegrity } from './archive-stage.js';

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
  'evolution_propose',
  'evolution_trial',
  'evolution_measure',
  'evolution_revert',
  'evolution_promote',
  'evolution_canary_observe',
  'evolution_history',
  'evolution_maintain',
  'evolution_doctor',
]);

/** Host services `lib/index.js` and `lib/registration.js` inject. */
export const REQUIRED_RUNTIME_SERVICES = Object.freeze(['tools', 'dynamicCordisRunner', 'systemPrompt', 'loader', 'storageDomain']);

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
  'lib/compat/legacy-startup-drift.js',
  'scripts/doctor.mjs',
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

// ---------------------------------------------------------------------------
// path resolution (host-free; mirrors lib/index.js storageConfig without
// creating anything)
// ---------------------------------------------------------------------------

export function resolveEvolutionPaths({ dshHome, dataRoot } = {}) {
  const home = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const root = path.resolve(dataRoot || path.join(home, 'storages', 'evolution'));
  return {
    dshHome: home,
    dataRoot: root,
    presetDir: root,
    presetId: 'evolution',
    keyPath: path.join(root, 'event-bridge.key'),
    pluginRoot: path.join(root, 'promoted'),
    compositionPath: path.join(root, 'promoted.cordis.yml'),
    evolutionPath: path.join(root, 'EVOLUTION.md'),
    archiveDir: path.join(root, 'archive', 'experiments'),
    promotionStateDir: path.join(root, 'promotion'),
    promotionLockPath: path.join(root, 'promotion.lock'),
    memoryPath: path.join(root, 'evolution-memory.json'),
    eventBridgePath: path.join(root, 'execution-events.jsonl'),
    driftStatePath: path.join(root, 'official-runtime-baseline.json'),
    ownershipDir: path.join(root, 'ownership'),
    dockyardDir: path.join(root, 'dockyard'),
    domainStagingDir: path.join(root, 'domain-staging'),
    domainArchiveLockPath: path.join(root, 'domain-archive.lock'),
    migrationManifestPath: path.join(root, 'migration-manifest.json'),
    domainGlobalPath: path.join(home, 'storages', 'evolution_domain.json'),
  };
}

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
  const match = SEMVER_PATTERN.exec(String(value).trim());
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

/**
 * Find the DSH CLI that boots this profile. Explicit input wins; every other
 * candidate is recorded so a wrong host is attributable instead of silent.
 */
export function resolveHostCli({ cliPath, dshHome, packageRoot = PACKAGE_ROOT, profileDir, runningEntry } = {}) {
  const candidates = [];
  if (cliPath) candidates.push({ path: path.resolve(cliPath), source: 'argument' });
  if (process.env.DSH_CLI) candidates.push({ path: path.resolve(process.env.DSH_CLI), source: 'DSH_CLI' });
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
  const local = path.join(packageRoot, 'node_modules', '.bin', 'dsh');
  if (statSafe(local)) candidates.push({ path: local, source: 'plugin-node-modules' });

  const inspected = candidates.map((candidate) => {
    let real = candidate.path;
    try { real = fs.realpathSync(candidate.path); } catch { /* keep the candidate path */ }
    const meta = packageRootFromCli(real);
    const isDsh = meta.manifest?.name === '@deepseek-ai/dsh';
    return { ...candidate, realPath: real, isDsh, packageRoot: isDsh ? meta.packageRoot : null, version: isDsh ? meta.manifest.version || null : null, bin: isDsh ? meta.manifest.bin || null : null };
  });
  const selected = inspected.find((candidate) => candidate.isDsh) || null;
  const alternatives = inspected.filter((candidate) => candidate.isDsh && candidate !== selected);
  return { selected, candidates: inspected, alternatives };
}

export function defaultRunDumpConfig({ cliPath, dshHome, profile, timeoutMs = 120000 }) {
  const result = spawnSync(process.execPath, [cliPath, '--profile', profile, '--dump-config'], {
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
        const nameMatch = /^\s+name:\s*(.+)$/.exec(candidate);
        if (nameMatch && name === null) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
        const disabledMatch = /^\s+disabled:\s*(.+)$/.exec(candidate);
        if (disabledMatch && disabled === null) disabled = disabledMatch[1].trim();
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
// split a code point, so the unfinished line bytes are retained until LF.
const EVENT_BRIDGE_SCAN_CHUNK_BYTES = 1 << 20;
/** The timestamp shape the plugin's producers write; only these take part in a
 *  reported oldest/newest range. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

function scanJsonLinesFile(file, onLine) {
  const descriptor = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(EVENT_BRIDGE_SCAN_CHUNK_BYTES);
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
  if (orchestrator?.name !== 'dsh-evolution') problems.push('evolution-orchestrator must mount dsh-evolution');
  if (guard?.name !== 'dsh-evolution/guard') problems.push('evolution-trust-root-guard must mount dsh-evolution/guard');
  if (problems.length > 0) {
    addCheck(report, {
      id: 'plugin.patch', category: 'plugin', level: LEVEL.BLOCKED,
      summary: 'The bundle patch does not declare the expected loader entries.',
      evidence: { patchPath, problems, entries: inserted.map((entry) => entry?.id ?? null) },
      remediation: 'Reinstall the bundle tarball.',
    });
  } else {
    addCheck(report, {
      id: 'plugin.patch', category: 'plugin', level: LEVEL.OK,
      summary: 'The bundle patch declares both loader entries.',
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

function diagnoseHostCli(report, { dshHome, profile, profileDir, cliPath, peers, probe, runningEntry }) {
  const resolution = resolveHostCli({ cliPath, dshHome, profileDir, runningEntry });
  const { selected } = resolution;
  if (!selected) {
    addCheck(report, {
      id: 'host.cli', category: 'host', level: LEVEL.NOT_EVALUATED,
      summary: 'No DSH CLI was found, so host version and composed profile could not be verified.',
      evidence: { reason: 'no DSH CLI candidate resolved to @deepseek-ai/dsh', candidates: resolution.candidates.map((candidate) => ({ path: candidate.path, source: candidate.source })) },
      remediation: 'Pass --dsh-cli <path/to/@deepseek-ai/dsh/lib/bin.js> or make `dsh` available on PATH.',
    });
    return { selected: null, version: null, resolution };
  }
  const supported = peers?.['@deepseek-ai/dsh'] || null;
  const satisfies = Boolean(selected.version && supported && satisfiesRange(selected.version, supported));
  const verified = Boolean(selected.version && SUPPORTED_DSH_VERSIONS.includes(selected.version));
  // The documented contract is exact declared versions only: a version string
  // that merely satisfies the range (build metadata, a `v` prefix) is not a
  // release this bundle's host-surface contract was verified against, so the
  // verdict follows `verified` and the evidence keeps both facts.
  const versionOk = satisfies && verified;
  const hostModules = HOST_MODULES.map((module) => {
    const found = resolveFrom(path.join(selected.packageRoot, 'package.json'), `${module.name}/package.json`);
    const peerRange = peers?.[module.name];
    return {
      name: module.name, kind: module.kind, blocking: module.blocking,
      version: found.version || null,
      resolved: Boolean(found.resolved),
      error: found.error || null,
      supported: peerRange || null,
      satisfies: found.version && peerRange ? satisfiesRange(found.version, peerRange) : null,
    };
  });
  const blockingProblems = hostModules.filter((module) => module.blocking && (!module.resolved || module.satisfies === false));
  const advisoryProblems = hostModules.filter((module) => !module.blocking && (!module.resolved || module.satisfies === false));

  addCheck(report, {
    id: 'host.cli', category: 'host', level: LEVEL.OK,
    summary: `Resolved DSH CLI (${selected.source}) with @deepseek-ai/dsh@${selected.version}.`,
    evidence: {
      source: selected.source, cli: selected.path, realPath: selected.realPath, packageRoot: selected.packageRoot,
      candidates: resolution.candidates.map((candidate) => ({ path: candidate.path, source: candidate.source, isDsh: candidate.isDsh, version: candidate.version })),
      conflictingHosts: resolution.alternatives.filter((candidate) => candidate.version && candidate.version !== selected.version).map((candidate) => ({ source: candidate.source, version: candidate.version })),
    },
    ...(resolution.alternatives.some((candidate) => candidate.version && candidate.version !== selected.version)
      ? { remediation: 'Another DSH installation on this machine has a different version; pass --dsh-cli to state which host this report should describe.' }
      : {}),
  });
  addCheck(report, {
    id: 'host.version', category: 'host', level: versionOk ? LEVEL.OK : LEVEL.BLOCKED,
    summary: versionOk
      ? `Host version ${selected.version} satisfies the supported range ${supported}, and is one of the host versions verified by a real install acceptance run (${SUPPORTED_DSH_VERSIONS.join(', ')}).`
      : satisfies
        ? `Host version ${selected.version} satisfies the supported range ${supported}, but it is not one of the versions verified by a real install acceptance run (${SUPPORTED_DSH_VERSIONS.join(', ')}).`
        : `Host version ${selected.version ?? 'unknown'} does not satisfy the supported range ${supported ?? 'unknown'}.`,
    evidence: { found: selected.version, supported, verified, verifiedHosts: SUPPORTED_DSH_VERSIONS, cli: selected.path },
    remediation: versionOk ? undefined : `Install a verified DSH (${SUPPORTED_DSH_VERSIONS.join(' or ')}) before enabling this bundle: the host-surface contract recorded in lib/cordis-compat.js is only verified for those releases, and the doctor reports an unverified host as blocked instead of guessing that it is compatible.`,
    recoverable: false,
  });
  addCheck(report, {
    id: 'host.modules', category: 'host', level: blockingProblems.length > 0 ? LEVEL.BLOCKED : advisoryProblems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
    summary: blockingProblems.length > 0
      ? `${blockingProblems.length} required host module(s) missing or out of range.`
      : advisoryProblems.length > 0
        ? `${advisoryProblems.length} optional host module(s) unavailable; a degraded capability is expected.`
        : 'Every required and optional host module resolved inside the supported range.',
    evidence: { modules: hostModules, blockingProblems: blockingProblems.map((module) => module.name), advisoryProblems: advisoryProblems.map((module) => module.name) },
    remediation: blockingProblems.length > 0 ? 'Reinstall the matching DSH release; the bundle imports these modules directly.' : undefined,
    recoverable: false,
  });

  const composition = diagnoseComposition({ report, dshHome, profile, profileDir, selected, probe });
  return { selected, version: selected.version, hostModules, composition };
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
  const run = probe?.runDumpConfig || defaultRunDumpConfig;
  const outcome = run({ cliPath: selected.path, dshHome, profile });
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
  const isDisabled = (entry) => Boolean(entry && entry.disabled !== null && !/^false$/.test(entry.disabled));
  if (!orchestratorEntry) problems.push('evolution-orchestrator entry is absent');
  else if (isDisabled(orchestratorEntry)) problems.push('evolution-orchestrator is disabled');
  if (orchestratorEntry && orchestratorEntry.name !== 'dsh-evolution') problems.push(`evolution-orchestrator mounts ${orchestratorEntry.name}`);
  if (!guardEntry) problems.push('evolution-trust-root-guard entry is absent');
  else if (isDisabled(guardEntry)) problems.push('evolution-trust-root-guard is disabled');
  const level = problems.length > 0 ? LEVEL.BLOCKED : LEVEL.OK;
  addCheck(report, {
    id: 'host.composition', category: 'host', level,
    summary: problems.length > 0
      ? `The composed profile is missing ${problems.length} required bundle entry/entries.`
      : 'The composed profile contains both bundle entries in the enabled state.',
    evidence: { profile, entries: section.entries, problems, sectionTitles: section.rawTitles, patched: section.patched, eventBridgeWriter: writer },
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
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { problems.push(`${name} unreadable`); evidence.dockyard.jsonl.push({ name, error: String(error.message || error) }); continue; }
    const inspected = inspectJsonLinesSummary(text);
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
  if (staging.length > 0 && problems.length === 0) problems.push(`${staging.length} staged import directorie(s) remain after the publish`);
  const level = evidenceChanges.length > 0 || problems.some((problem) => problem.includes('importId') || problem.includes('schema')) ? LEVEL.BLOCKED : problems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK;
  const repair = staging.length > 0 && level !== LEVEL.BLOCKED
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
  const descriptor = descriptors[state];
  addCheck(report, {
    id: 'promotion.journal', category: 'promotion', level: descriptor.level,
    summary: descriptor.summary,
    evidence: { ...base, boundary: boundary || null },
    remediation: descriptor.remediation,
    recoverable: descriptor.recoverable,
    ...(descriptor.repair ? { repair: descriptor.repair } : {}),
  });
  return { state, phase, lock, journal: base };
}

/**
 * The promotion-journal boundary rule is owned by the orchestrator, so this
 * report and recovery refuse exactly the same journals for the same reason.
 * Re-exported here for the doctor's report consumers.
 */
export { checkJournalBoundary };

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
      addCheck(report, {
        id: 'promotion.composition', category: 'promotion', level: LEVEL.BLOCKED,
        summary: 'promoted.cordis.yml is not valid YAML; the official Include cannot mount it.',
        evidence: { compositionPath: paths.compositionPath, error: String(error.message || error) },
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
export async function collectDiagnostics(options = {}) {
  const paths = options.paths || resolveEvolutionPaths(options);
  const packageRoot = options.packageRoot || PACKAGE_ROOT;
  const manifest = readPeerRange(packageRoot);
  const report = createReport({ mode: options.live && options.ctx ? 'host' : 'cli', plugin: { name: manifest.name, version: manifest.version, packageRoot } });

  if (options.home) addCheck(report, { id: 'plugin.home', category: 'plugin', level: LEVEL.OK, summary: `Diagnosing DSH home ${paths.dshHome}.`, evidence: { dshHome: paths.dshHome, dataRoot: paths.dataRoot, profile: options.profile ?? null } });

  diagnosePackage(report, { packageRoot });
  await diagnosePatch(report, { packageRoot });
  await diagnosePlatformVersion(report, paths);
  const profileDir = options.profileDir || (options.profile && options.dshHome ? path.join(paths.dshHome, 'profiles', options.profile) : null);
  const installedInfo = diagnoseInstalled(report, { profileDir, packageRoot, profileCandidates: options.profileCandidates });
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
