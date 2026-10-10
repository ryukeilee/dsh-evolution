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
import { verifyEventBridgeEnvelope, recoverInterruptedPromotion, isUsableMemoryEntry, inspectMemoryText } from './orchestrator.js';
import { probeSurfaces, SURFACE_PRIVATE } from './cordis-compat.js';

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
 * promotion/rollback acceptance run (see COMPATIBILITY.md). Satisfying the
 * range therefore means "verified", and a host outside it is blocked, never
 * silently accepted.
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
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error) { return { error }; }
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

/** Read-only lock inspection; never removes anything. Handles both the
 * directory lock (promotion, `lock.json`) and the bare-pid file lock used by
 * the domain archive writer. */
function inspectLock(lockPath) {
  const stat = statSafe(lockPath);
  if (!stat) return { present: false };
  if (!stat.isDirectory()) {
    // domain-archive.lock is a single file containing the owning pid.
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
 * Conservative semver check for exact, `^`, `~`, `>=`, `>`, `<=`, `<` and `||`.
 * A prerelease version is never accepted by a range without a prerelease
 * comparator, matching the strict reading of official peer ranges.
 */
export function satisfiesRange(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return false;
  if (version === range) return true;
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value).trim());
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || null } : null;
  };
  const left = parse(version);
  if (!left) return false;
  const compare = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch
    || (a.pre === b.pre ? 0 : a.pre === null ? 1 : b.pre === null ? -1 : a.pre.localeCompare(b.pre));
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((comparator) => {
      const match = /^(\^|~|>=|<=|>|<)?\s*(.+)$/.exec(comparator);
      if (!match) return false;
      const [, operator = '', target] = match;
      const right = parse(target);
      if (!right) return false;
      if (right.pre === null && left.pre !== null) return false;
      switch (operator) {
        case '': return compare(left, right) === 0;
        case '>=': return compare(left, right) >= 0;
        case '>': return compare(left, right) > 0;
        case '<=': return compare(left, right) <= 0;
        case '<': return compare(left, right) < 0;
        case '^': return compare(left, right) >= 0
          && (right.major > 0 ? left.major === right.major
            : right.minor > 0 ? left.major === 0 && left.minor === right.minor
              : left.major === 0 && left.minor === 0 && left.patch === right.patch);
        case '~': return compare(left, right) >= 0 && left.major === right.major && left.minor === right.minor;
        default: return false;
      }
    });
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

/** Parse `dsh --dump-config` output: bundle sections and the entries inside. */
export function parseComposedProfile(dump) {
  const sections = new Map();
  let current = null;
  const lines = String(dump || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = /^# == (.+)$/.exec(line);
    if (header) {
      current = { title: header[1], entries: [], startLine: index + 1 };
      sections.set(header[1], current);
      continue;
    }
    const entry = /^- id: (.+)$/.exec(line);
    if (entry && current) {
      let name = null;
      let disabled = null;
      for (let cursor = index + 1; cursor < lines.length && !/^- id: |^# == /.test(lines[cursor]); cursor += 1) {
        const nameMatch = /^\s+name:\s*(.+)$/.exec(lines[cursor]);
        if (nameMatch && name === null) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
        const disabledMatch = /^\s+disabled:\s*(.+)$/.exec(lines[cursor]);
        if (disabledMatch && disabled === null) disabled = disabledMatch[1].trim();
      }
      current.entries.push({ id: entry[1].trim(), name, disabled });
    }
  }
  return { sections, titles: [...sections.keys()] };
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
    try { records.push({ line: index + 1, value: JSON.parse(line) }); } catch (error) { records.push({ line: index + 1, error: String(error.message || error) }); }
  });
  return {
    records,
    lineCount: body.length,
    invalid: records.filter((record) => record.error),
    complete: !records.some((record) => record.error),
    truncatedTail: !endsWithNewline && body.length > 0 && Boolean(body[body.length - 1].trim()),
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
  const versionOk = Boolean(selected.version && supported && satisfiesRange(selected.version, supported));
  const verified = Boolean(selected.version && SUPPORTED_DSH_VERSIONS.includes(selected.version));
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
    evidence: { profile, entries: section.entries, problems },
    remediation: problems.length > 0 ? 'Reinstall the bundle or re-enable it through the official plugin manager, then restart.' : undefined,
    recoverable: false,
  });
  return { entries: section.entries, problems };
}

function diagnoseDataRoot(report, paths, { live = false, installed = false } = {}) {
  const stat = statSafe(paths.dataRoot);
  const keyStat = statSafe(paths.keyPath);
  const lock = inspectLock(paths.domainArchiveLockPath);
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
      if (!keyStat) {
        if (entryCount > 0) blocking.push('event bridge key is missing from an initialized data root');
        else advisory.push('event bridge key is not created yet (created on first run)');
      } else if (!keyStat.isFile()) blocking.push('event bridge key is not a regular file');
    }
  }
  let key = null;
  if (keyStat?.isFile()) {
    key = fs.readFileSync(paths.keyPath, 'utf8').trim();
    if (!HEX64.test(key)) blocking.push('event bridge key is not 64 lowercase hex characters');
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
      key: keyStat ? { present: true, mode: (keyStat.mode & 0o777).toString(8), valid: HEX64.test(key || '') } : { present: false },
      archiveLock: lock,
      problems,
      blockingProblems: blocking,
      advisoryProblems: advisory,
    },
    remediation: blocking.length > 0
      ? 'Restore or recreate the data root before starting the plugin; an invalid or missing key on an initialized root is never replaced automatically.'
      : advisory.length > 0 ? 'Start the plugin once; it creates the data root and its event-bridge key.' : undefined,
    recoverable: false,
  });
  if (keyStat?.isFile() && !HEX64.test(key || '')) {
    addCheck(report, {
      id: 'data.key', category: 'data', level: LEVEL.BLOCKED,
      summary: 'The event bridge key is malformed; the plugin refuses to start rather than replace it.',
      evidence: { keyPath: paths.keyPath, length: (key || '').length, shape: HEX64.test(key || '') ? 'hex64' : 'invalid' },
      remediation: 'Restore the original event-bridge.key (a replacement invalidates every recorded event MAC).',
      recoverable: false,
    });
  }
  return { key, lock };
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
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(paths.memoryPath)); } catch { text = null; }
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
  addCheck(report, {
    id: 'state.archives', category: 'state', level: problems.length > 0 ? LEVEL.DEGRADED : LEVEL.OK,
    summary: problems.length > 0
      ? `Cold archives and rotation files have ${problems.length} integrity issue(s); the append-only originals are preserved.`
      : `Cold archive and rotation files are readable (${evidence.archives} experiment file(s)).`,
    evidence: { ...evidence, problems },
    remediation: problems.length > 0 ? 'Keep the files: they are append-only evidence. Rebuild the index only from readable rotation files.' : undefined,
    recoverable: false,
  });
  return legacyState;
}

async function diagnoseEventBridge(report, paths, { key }) {
  const stat = statSafe(paths.eventBridgePath);
  if (!stat) {
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.OK,
      summary: 'No execution event bridge yet (fresh install).',
      evidence: { eventBridgePath: paths.eventBridgePath, present: false },
    });
    return null;
  }
  if (!key) {
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.BLOCKED,
      summary: 'The event bridge exists but its signing key is missing or invalid, so no record can be verified.',
      evidence: { eventBridgePath: paths.eventBridgePath, bytes: stat.size, keyAvailable: false },
      remediation: 'Restore the original event-bridge.key; without it every envelope fails verification and the plugin refuses to start.',
      recoverable: false,
    });
    return null;
  }
  let text;
  try { text = fs.readFileSync(paths.eventBridgePath, 'utf8'); } catch (error) {
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.BLOCKED,
      summary: 'The execution event bridge is unreadable.',
      evidence: { eventBridgePath: paths.eventBridgePath, error: String(error.message || error) },
      recoverable: false,
    });
    return null;
  }
  const inspected = inspectJsonLines(text);
  const unverifiable = [];
  const malformed = [];
  const byEventId = new Map();
  const conflicts = [];
  let duplicates = 0;
  for (const record of inspected.records) {
    if (record.empty) continue;
    if (record.error) { malformed.push({ line: record.line, error: record.error }); continue; }
    const verified = verifyEventBridgeEnvelope(record.value, key);
    if (!verified) { unverifiable.push({ line: record.line, sequence: record.value?.sequence ?? null, writer: record.value?.writer ?? null }); continue; }
    const eventId = typeof verified.event?.eventId === 'string' ? verified.event.eventId : null;
    if (!eventId) continue;
    const mac = record.value.mac;
    const previous = byEventId.get(eventId);
    if (previous && previous !== mac) conflicts.push({ eventId, lines: previous, mac });
    else if (previous) duplicates += 1;
    else byEventId.set(eventId, mac);
  }
  const problems = [];
  if (malformed.length > 0) problems.push(`${malformed.length} malformed line(s)`);
  if (unverifiable.length > 0) problems.push(`${unverifiable.length} envelope(s) fail MAC verification`);
  if (conflicts.length > 0) problems.push(`${conflicts.length} event id(s) recorded with conflicting MACs`);
  const truncated = inspected.truncatedTail && malformed.some((entry) => entry.line === inspected.lineCount);
  const evidence = {
    eventBridgePath: paths.eventBridgePath, bytes: stat.size, lines: inspected.lineCount,
    verifiedEvents: byEventId.size, duplicateRecords: duplicates,
    unverifiable, malformed: malformed.slice(0, 8), conflicts: conflicts.slice(0, 8),
    truncatedTail: truncated,
  };
  if (problems.length > 0) {
    const repair = truncated && malformed.length === 1 && unverifiable.length === 0 && conflicts.length === 0
      ? {
        id: 'event-bridge-trim-partial-tail',
        safe: true,
        description: `Drop the unterminated final line ${inspected.lineCount} (${malformed[0].error}); no complete record is removed.`,
      }
      : undefined;
    addCheck(report, {
      id: 'state.event-bridge', category: 'state', level: LEVEL.BLOCKED,
      summary: `The event bridge cannot be replayed as-is: ${problems.join('; ')}.`,
      evidence,
      remediation: conflicts.length > 0
        ? 'Conflicting MACs mean the same event id was recorded with different content; freeze the file and resolve by hand (the plugin refuses to guess).'
        : 'Restore the original key or the original file; the plugin refuses to start on unverifiable events.',
      recoverable: Boolean(repair),
      ...(repair ? { repair } : {}),
    });
    return { ...evidence, problems };
  }
  addCheck(report, {
    id: 'state.event-bridge', category: 'state', level: LEVEL.OK,
    summary: `Event bridge verifies: ${byEventId.size} signed event(s), ${duplicates} idempotent duplicate(s).`,
    evidence,
  });
  return { ...evidence, problems };
}

async function diagnoseDomain(report, paths, { migration }) {
  const stat = statSafe(paths.domainGlobalPath);
  const staging = fs.existsSync(paths.domainStagingDir)
    ? fs.readdirSync(paths.domainStagingDir).filter((name) => STAGE_NAME.test(name)).sort()
    : [];
  if (!stat) {
    addCheck(report, {
      id: 'state.domain', category: 'state', level: LEVEL.OK,
      summary: 'No domain aggregate yet; the host creates it from the empty initial state.',
      evidence: { domainGlobalPath: paths.domainGlobalPath, present: false, staging },
    });
    return null;
  }
  const parsed = readJsonSafe(paths.domainGlobalPath);
  if (parsed.error) {
    addCheck(report, {
      id: 'state.domain', category: 'state', level: LEVEL.BLOCKED,
      summary: 'The domain storage unit is not valid JSON; the host cannot open it.',
      evidence: { domainGlobalPath: paths.domainGlobalPath, bytes: stat.size, error: String(parsed.error.message || parsed.error), staging },
      remediation: 'Restore from a backup or move the file aside after copying it; the plugin never rewrites an unreadable domain unit.',
      recoverable: false,
    });
    return null;
  }
  const value = parsed.value || {};
  const problems = [];
  if (value.unit?.name !== 'evolution_domain') problems.push(`unit name is ${JSON.stringify(value.unit?.name)}`);
  if (!Number.isInteger(value.unit?.version)) problems.push('unit version is not an integer');
  if (value.global?.schema !== 1) problems.push(`global schema is ${JSON.stringify(value.global?.schema)} (expected 1)`);
  const pending = value.global?.pending ?? null;
  const applied = value.global?.applied ?? {};
  const appliedKeys = Object.keys(applied);
  const badMacs = appliedKeys.filter((id) => !HEX.test(String(applied[id])));
  if (badMacs.length > 0) problems.push(`${badMacs.length} applied marker(s) are not hex digests`);
  let schemaErrors = null;
  const advisory = [];
  if (problems.length === 0) {
    const validator = await loadDomainSchemaValidator();
    if (validator) {
      const check = validator.safeParse(value.global);
      if (!check.success) schemaErrors = check.error.issues.slice(0, 8).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    } else {
      advisory.push('runtime domain schema validator unavailable; structural checks only');
    }
  }
  const pendingState = !pending ? 'none' : STAGE_NAME.test(String(pending.stage || '')) ? (staging.includes(pending.stage) ? 'replayable' : 'missing-archive') : 'malformed';
  const blocking = [...problems];
  if (pendingState === 'missing-archive') blocking.push(`pending transaction references ${pending.stage} but that staging directory is absent`);
  if (pendingState === 'malformed') blocking.push('pending transaction has a malformed stage name');
  if (pendingState === 'replayable') advisory.push(`an interrupted write is replayable from staging ${pending.stage} on the next start`);
  const orphanStaging = staging.filter((name) => !pending || pending.stage !== name);
  if (orphanStaging.length > 0) advisory.push(`${orphanStaging.length} staging directorie(s) are not referenced by a pending transaction`);

  const lock = inspectLock(paths.domainArchiveLockPath);
  const staleLock = lock.present && !lock.active && (lock.malformed === true || (typeof lock.owner?.pid === 'number')) && (lock.malformed !== true || (lock.ageMs ?? 0) >= 1000);
  if (staleLock) advisory.push(lock.malformed
    ? 'the domain archive lock holds no owner pid (an interrupted writer left it behind) and would block the next start'
    : 'the domain archive lock names a process that is no longer running');
  const repair = orphanStaging.length > 0 && !lock.active
    ? {
      id: 'domain-orphan-staging',
      safe: true,
      description: `Remove ${orphanStaging.length} staging directorie(s) that no pending transaction references, with no live writer holding the archive lock.`,
    }
    : staleLock
      ? {
        id: 'domain-stale-lock',
        safe: true,
        description: 'Remove the unusable domain archive lock (no live owner) so the plugin can start; the runtime reclaims the same condition at startup.',
      }
      : undefined;
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
      schemaErrors,
      problems: [...blocking, ...advisory],
      blockingProblems: blocking,
      advisoryProblems: advisory,
      archiveLock: lock,
      staleLock,
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
  return { applied: appliedKeys.length, pending, staging, problems: blocking };
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
    addCheck(report, {
      id: 'promotion.journal', category: 'promotion', level: LEVEL.DEGRADED,
      summary: 'A promotion state directory exists without a journal; its provenance is unknown.',
      evidence: { promotionStateDir: paths.promotionStateDir, state: 'unknown', leftovers, lock },
      remediation: 'Move the directory aside after copying it. The doctor will not delete promotion state it cannot classify.',
      recoverable: false,
    });
    return { state: 'unknown', lock };
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
  const phase = journal.phase;
  const boundary = checkJournalBoundary(journal, paths);
  let state;
  if (boundary) state = 'state-unknown';
  else if (phase === 'prepared' || phase === 'committing') state = 'incomplete';
  else if (phase === 'canary-observing') state = 'canary-observing';
  else if (phase === 'stable-committed' || phase === 'committed') state = 'committed-pending-cleanup';
  else if (phase === 'rollback-failed') state = 'rollback-failed';
  else state = 'state-unknown';

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
      summary: boundary ? 'The promotion journal references targets outside the configured roots; refusal is the safe answer.' : 'The promotion journal has an unrecognised phase; refusal is the safe answer.',
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

/** Mirror of the orchestrator boundary check so a poisoned journal is visible in a report too. */
export function checkJournalBoundary(journal, paths) {
  const within = (target, root) => typeof target === 'string' && typeof root === 'string'
    && (path.resolve(target) === path.resolve(root) || path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`));
  if (typeof journal?.stateDir !== 'string' || path.resolve(journal.stateDir) !== path.resolve(paths.promotionStateDir)) {
    return 'journal stateDir is outside the configured promotion state directory';
  }
  if (journal.stageDir && !within(journal.stageDir, paths.promotionStateDir)) return 'journal stageDir escapes its state directory';
  if (!Array.isArray(journal.records)) return 'journal has no change plan';
  const roots = [paths.pluginRoot, paths.dataRoot, paths.archiveDir].filter(Boolean);
  for (const record of journal.records) {
    if (!['file', 'path', 'symlink'].includes(record?.type) || typeof record?.target !== 'string') return 'journal record has an unsupported shape';
    if (within(record.target, paths.promotionStateDir)) return 'journal record targets its own state directory';
    if (!roots.some((root) => within(record.target, root))) return 'journal record targets a path outside the configured roots';
    if (record.type === 'file' && (typeof record.backup !== 'string' || path.basename(record.backup) !== record.backup)) return 'journal backup name is not a bare file name';
  }
  return null;
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
        const archiveLock = inspectLock(paths.domainArchiveLockPath);
        if (lock.active || archiveLock.active) {
          applied.push({ id: repair.id, status: 'skipped', detail: 'a live process holds the promotion/archive lock; stop the application first' });
          continue;
        }
        const outcome = await recoverInterruptedPromotion({ ...paths, promotionRuntime: undefined });
        applied.push({ id: repair.id, status: outcome.recovered === false && outcome.status === 'canary-pending' ? 'skipped' : 'applied', detail: outcome.status });
        continue;
      }
      if (repair.id === 'event-bridge-trim-partial-tail') {
        const text = fs.readFileSync(paths.eventBridgePath, 'utf8');
        const cut = text.lastIndexOf('\n');
        if (cut < 0) { applied.push({ id: repair.id, status: 'skipped', detail: 'no complete line to keep' }); continue; }
        const kept = text.slice(0, cut + 1);
        const temp = `${paths.eventBridgePath}.${process.pid}.trim.tmp`;
        fs.writeFileSync(temp, kept, { mode: 0o600 });
        const handle = fs.openSync(temp, 'r');
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
        fs.renameSync(temp, paths.eventBridgePath);
        applied.push({ id: repair.id, status: 'applied', detail: `kept ${kept.length} verified bytes, dropped ${text.length - kept.length} byte(s) of unterminated tail` });
        continue;
      }
      if (repair.id === 'domain-stale-lock') {
        const lock = inspectLock(paths.domainArchiveLockPath);
        if (!lock.present) { applied.push({ id: repair.id, status: 'skipped', detail: 'no lock file left to remove' }); continue; }
        if (lock.active) { applied.push({ id: repair.id, status: 'skipped', detail: 'a live process owns the lock' }); continue; }
        try { fs.unlinkSync(paths.domainArchiveLockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        applied.push({ id: repair.id, status: 'applied', detail: lock.malformed ? 'removed an ownerless lock file' : `removed the lock of dead pid ${lock.owner?.pid}` });
        continue;
      }
      if (repair.id === 'domain-orphan-staging') {
        const lock = inspectLock(paths.domainArchiveLockPath);
        if (lock.active) { applied.push({ id: repair.id, status: 'skipped', detail: 'a live process holds the domain archive lock' }); continue; }
        const parsed = readJsonSafe(paths.domainGlobalPath);
        const pending = parsed.value?.global?.pending ?? null;
        const removed = [];
        for (const name of fs.existsSync(paths.domainStagingDir) ? fs.readdirSync(paths.domainStagingDir) : []) {
          if (!STAGE_NAME.test(name)) continue;
          if (pending && pending.stage === name) continue;
          fs.rmSync(path.join(paths.domainStagingDir, name), { recursive: true, force: true });
          removed.push(name);
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

  const data = diagnoseDataRoot(report, paths, { live: options.live === true && Boolean(options.ctx), installed: Boolean(installedInfo?.installedVersion) });
  await diagnoseMemory(report, paths);
  const legacyState = await diagnoseArchives(report, paths);
  const bridge = await diagnoseEventBridge(report, paths, { key: data.key });
  const migration = await diagnoseMigration(report, paths);
  const domain = await diagnoseDomain(report, paths, { migration: migration.manifest });
  if (legacyState) addCheck(report, legacyState);
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
