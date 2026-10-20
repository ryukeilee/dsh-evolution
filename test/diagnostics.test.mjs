// Fault-injection tests for the unified doctor entry point.
//
// Every fixture is synthetic and lives in os.tmpdir(). Nothing here reads a
// real DSH home, real Evolution memory, or a private migration workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  collectDiagnostics, runDiagnostics, exitCodeFor, applyRepairs,
  resolveEvolutionPaths, satisfiesRange, inspectJsonLines, checkJournalBoundary,
  parseComposedProfile, composedEventBridgeWriter, EVOLUTION_TOOL_NAMES, SUPPORTED_DSH_VERSIONS,
} from '../lib/diagnostics.js';
import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, signEventBridgeEnvelope, verifyEventBridgeEnvelope } from '../lib/orchestrator.js';
import { evolutionDomainSpec } from '../lib/domain-storage.js';
import { EVOLUTION_TOOLS } from '../lib/registration.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const KEY = 'a'.repeat(64);
const scratchRoots = [];

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evo-doctor-${name}-`));
  scratchRoots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const checkOf = (report, id) => report.checks.find((check) => check.id === id);
const levelOf = (report, id) => checkOf(report, id)?.level;

/** A home with an initialized data root, event-bridge key, and nothing else. */
function freshHome(name = 'home') {
  const home = scratch(name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  return { home, paths };
}

function writeDomain(paths, global) {
  fs.mkdirSync(path.dirname(paths.domainGlobalPath), { recursive: true });
  fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global, tables: {} }));
}

function domainGlobal({ applied = {}, pending = null, evolution = { schema: 4, observations: [], proposals: [] } } = {}) {
  return { schema: 1, aggregate: { evolution }, applied, pending };
}

function writeBridge(paths, events, { corruptMac = false, truncateTail = false, keyOverride = null } = {}) {
  const lines = events.map((event, index) => {
    const envelope = signEventBridgeEnvelope(event, { key: keyOverride || KEY, sequence: index + 1 });
    if (corruptMac && index === events.length - 1) envelope.mac = 'b'.repeat(64);
    return JSON.stringify(envelope);
  });
  let text = `${lines.join('\n')}\n`;
  if (truncateTail) text += '{"schema":2,"writer":"dsh-evolution';
  fs.writeFileSync(paths.eventBridgePath, text);
  return text;
}

function writePromotedPlugin(paths, durableId) {
  const dir = path.join(paths.pluginRoot, `dsh-evolution-promoted-${durableId}`);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `dsh-evolution-promoted-${durableId}`, main: 'lib/index.js' }));
  const modulePath = path.join(dir, 'lib', 'index.js');
  fs.writeFileSync(modulePath, 'export const name = "promoted";\n');
  return { dir, modulePath, row: { id: `evolution-promoted-${durableId}`, name: `file://${modulePath}` } };
}

function writeComposition(paths, rows) {
  const yaml = rows.map((row) => `- id: ${row.id}\n  name: ${row.name}\n`).join('');
  fs.writeFileSync(paths.compositionPath, yaml);
}

/**
 * A `--dump-config` stdout carrying both bundle entries. `patchTitle` splits it
 * into the two sections the official CLI emits when a profile patch targets the
 * bundle (`# == dsh-evolution, patched by <path>` then `# == dsh-evolution`).
 */
function composedDump({ writer = null, patchTitle = null, includeOrchestrator = true, includeGuard = true } = {}) {
  const orchestrator = [];
  if (includeOrchestrator) {
    orchestrator.push('- id: evolution-orchestrator', '  name: dsh-evolution');
    if (writer !== null) orchestrator.push('  config:', `    eventBridgeWriter: ${writer}`);
  }
  const guard = includeGuard ? ['- id: evolution-trust-root-guard', '  name: dsh-evolution/guard', '  inject:', '    - tools'] : [];
  const lines = patchTitle
    ? [`# == ${patchTitle}`, ...orchestrator, '# == dsh-evolution', ...guard]
    : ['# == dsh-evolution', ...orchestrator, ...guard];
  lines.push('');
  return lines.join('\n');
}

/**
 * A `--dump-config` stdout whose `evolution-orchestrator` entry is followed by
 * exactly these body lines, at the two-space indent the official CLI emits.
 */
function orchestratorDump(bodyLines) {
  return ['# == dsh-evolution', '- id: evolution-orchestrator', '  name: dsh-evolution', ...bodyLines, '- id: evolution-trust-root-guard', '  name: dsh-evolution/guard', ''].join('\n');
}

function writeJournal(paths, { phase, records = [], experimentId = 'exp-test-1', canary = null, stateDir = paths.promotionStateDir, stageDir = null }) {
  fs.mkdirSync(path.join(stateDir, 'backups'), { recursive: true, mode: 0o700 });
  const journal = {
    version: 1,
    phase,
    experimentId,
    ownerId: 'owner-test',
    proposal: { why: 'test', target: 'plugin:x', impactScope: ['runtime'], successMetrics: ['m'], createdAt: new Date().toISOString() },
    targets: ['plugin:x'],
    stateDir,
    stageDir: stageDir || path.join(stateDir, 'stage'),
    records,
    canary: canary || { promotionTimestamp: new Date().toISOString(), healthObservationWindow: 2, startupVerified: false, observations: [] },
  };
  fs.writeFileSync(path.join(stateDir, 'journal.json'), JSON.stringify(journal, null, 2));
  return journal;
}

/** A journal whose targets currently hold the planned "after" bytes, exactly
 * like an interrupted commit: composition and pointer existed before, the
 * archive and plugin directory are new. */
function fileChangeJournal(paths, { phase, experimentId = 'exp-test-1' } = {}) {
  fs.mkdirSync(path.join(paths.promotionStateDir, 'backups'), { recursive: true, mode: 0o700 });
  const archivePath = path.join(paths.archiveDir, `${experimentId}.md`);
  const pluginPath = path.join(paths.pluginRoot, 'dsh-evolution-promoted-aaaaaaaaaaaa');
  const planned = [
    {
      target: paths.compositionPath,
      existed: true,
      before: '[]\n',
      after: `- id: evolution-promoted-aaaaaaaaaaaa\n  name: file://${path.join(pluginPath, 'lib', 'index.js')}\n`,
    },
    {
      target: paths.evolutionPath,
      existed: true,
      before: '\n## experiment pointer\n- last experiment: exp-previous-1 (stable)\n',
      after: '\n## experiment pointer\n- last experiment: exp-test-1 (canary-observing)\n',
    },
    {
      target: archivePath,
      existed: false,
      before: null,
      after: `# Evolution experiment ${experimentId}\n\n- state: canary-observing\n`,
    },
  ];
  const records = [];
  for (const [index, entry] of planned.entries()) {
    const backup = `${String(index).repeat(16)}.bak`;
    if (entry.before !== null) fs.writeFileSync(path.join(paths.promotionStateDir, 'backups', backup), entry.before);
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    fs.writeFileSync(entry.target, entry.after);
    records.push({
      type: 'file', target: entry.target, existed: entry.existed, backup,
      beforeDigest: entry.before === null ? null : sha256(entry.before),
      expectedAfter: sha256(entry.after), before: entry.before,
    });
  }
  fs.mkdirSync(pluginPath, { recursive: true });
  records.push({ type: 'path', target: pluginPath, existed: false });
  const journal = writeJournal(paths, { phase, records, experimentId });
  return { journal, targets: planned, records };
}

function validManifest(paths, files) {
  const entries = files.map((file) => {
    const target = path.join(paths.dataRoot, file.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    return { target: file.target, sha256: sha256(file.content), bytes: Buffer.byteLength(file.content) };
  }).sort((left, right) => left.target.localeCompare(right.target));
  const importId = sha256(JSON.stringify(entries));
  fs.writeFileSync(paths.migrationManifestPath, JSON.stringify({ schema: 1, importId, importedAt: new Date().toISOString(), files: entries, boundaries: ['No legacy promoted code execution'] }, null, 2));
  return { entries, importId };
}

function baseOptions(home, extra = {}) {
  return { home: true, dshHome: home, probe: { skipComposition: true }, ...extra };
}

/** A context that satisfies every required runtime surface. */
function healthyCtx({ missingServices = [], missingMethods = [], missingTools = [], hideInternalApi = false } = {}) {
  const definitions = new Map(EVOLUTION_TOOL_NAMES.map((name) => [name, { name, execute: () => null }]));
  for (const name of missingTools) definitions.delete(name);
  const ctx = {
    tools: {
      register: () => null,
      get: (name) => definitions.get(name) ?? undefined,
      schemas: () => [],
    },
    on: () => null,
    effect: () => null,
    systemPrompt: { section: () => null },
    get: (name) => (missingServices.includes(name) ? undefined : { name }),
  };
  ctx.systemPrompt = missingServices.includes('systemPrompt') ? undefined : { name: 'systemPrompt', section: () => null };
  for (const name of ['dynamicCordisRunner', 'loader', 'storageDomain']) {
    if (!missingServices.includes(name)) ctx[name] = { name };
  }
  ctx.tools.register = missingMethods.includes('ctx.tools.register') ? undefined : () => null;
  ctx.on = missingMethods.includes('ctx.on') ? undefined : () => null;
  ctx.effect = missingMethods.includes('ctx.effect') ? undefined : () => null;
  if (!hideInternalApi) {
    ctx.registry = { values: () => [] };
    ctx.reflect = { props: { tools: { type: 'service' } }, _getImpl: () => undefined };
    ctx.events = { _hooks: {} };
  }
  return ctx;
}

function liveOptions(home, extra = {}) {
  return {
    ...baseOptions(home, extra),
    live: true,
    ctx: extra.ctx || healthyCtx(),
    promotionRuntime: {
      verify: () => null, refresh: () => null, health: () => null,
      // Mirrors what lib/promotion-include.js records from the live loader tree.
      capabilities: { entryResolver: true, treeAwait: true, liveRootEntries: true },
    },
    domainStorage: { query: () => null, flush: () => null },
    config: { startupDrift: false, promotionAdapter: 'official-include' },
  };
}

// ---------------------------------------------------------------------------
// version range helper
// ---------------------------------------------------------------------------

test('satisfiesRange: exact, caret, tilde, comparators, and prerelease strictness', () => {
  assert.equal(satisfiesRange('0.2.0-rc.2', '0.2.0-rc.2'), true);
  assert.equal(satisfiesRange('0.2.0-rc.3', '0.2.0-rc.2'), false);
  assert.equal(satisfiesRange('0.3.0', '0.2.0-rc.2'), false);
  assert.equal(satisfiesRange('4.0.4', '^4.0.1'), true);
  assert.equal(satisfiesRange('4.3.2', '^4.2.0'), true);
  assert.equal(satisfiesRange('5.0.0', '^4.0.1'), false);
  assert.equal(satisfiesRange('4.1.0-rc.1', '^4.0.1'), false);
  assert.equal(satisfiesRange('0.2.0-rc.2', '0.2.0-rc.2 || 0.2.1-alpha.1'), true);
  assert.equal(satisfiesRange('0.2.1-alpha.1', '0.2.0-rc.2 || 0.2.1-alpha.1'), true);
  assert.equal(satisfiesRange('0.3.0', '0.2.0-rc.2 || 0.2.1-alpha.1'), false);
  assert.equal(satisfiesRange('4.0.4', '^4.0.1 || 4.0.5-alpha.1'), true);
  assert.equal(satisfiesRange('4.0.5-alpha.1', '^4.0.1 || 4.0.5-alpha.1'), true);
  assert.equal(satisfiesRange('1.0.10-alpha.1', '1.0.9 || 1.0.10-alpha.1'), true);
  assert.equal(satisfiesRange('22.19.0', '^22.19.0 || >=24.0.0'), true);
  assert.equal(satisfiesRange('26.10.0', '^22.19.0 || >=24.0.0'), true);
  assert.equal(satisfiesRange('23.0.0', '^22.19.0 || >=24.0.0'), false);
});

// ---------------------------------------------------------------------------
// plugin / host classification
// ---------------------------------------------------------------------------

test('healthy package reports ok and exit code 0', async () => {
  const { home } = freshHome('healthy');
  const report = await collectDiagnostics(baseOptions(home, { profileCandidates: [] }));
  assert.equal(levelOf(report, 'plugin.package'), 'ok');
  assert.equal(levelOf(report, 'plugin.patch'), 'ok');
  assert.equal(levelOf(report, 'data.root'), 'ok');
  assert.equal(report.status === 'healthy' || report.status === 'degraded', true, `unexpected status ${report.status}`);
  assert.equal(report.summary.blocked, 0);
  assert.equal(exitCodeFor(report), report.status === 'healthy' ? 0 : 1);
});

test('the tool manifest cannot drift from the registered surface', () => {
  assert.deepEqual([...EVOLUTION_TOOL_NAMES].sort(), [...EVOLUTION_TOOLS].sort());
});

test('the declared support matrix is exactly the verified host versions', () => {
  // Every exact declared alternative is verified by a real install run; see
  // COMPATIBILITY.md. This test keeps the declaration and the code in step.
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '0.2.0-rc.2 || 0.2.1-alpha.1 || 0.2.1-rc.2');
  assert.deepEqual(
    [...SUPPORTED_DSH_VERSIONS],
    manifest.peerDependencies['@deepseek-ai/dsh'].split('||').map((range) => range.trim()),
  );
  for (const version of SUPPORTED_DSH_VERSIONS) {
    assert.equal(satisfiesRange(version, manifest.peerDependencies['@deepseek-ai/dsh']), true, `${version} must satisfy the declared range`);
  }
  // Every declared module must declare a range that covers both hosts.
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name === 'js-yaml') continue;
    assert.match(range, /\|\|/, `${name} must declare every verified host release`);
  }
});

test('unsupported host version is blocked with supported-range evidence', async () => {
  const dir = scratch('host');
  const hostRoot = path.join(dir, 'fake-host', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(hostRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.3.0', bin: { dsh: 'lib/bin.js' } }));
  const { home } = freshHome('host-home');
  const report = await collectDiagnostics(baseOptions(home, { cliPath: path.join(hostRoot, 'lib', 'bin.js') }));
  assert.equal(levelOf(report, 'host.version'), 'blocked');
  assert.equal(report.status, 'blocked');
  assert.equal(exitCodeFor(report), 2);
  assert.match(checkOf(report, 'host.version').evidence.supported, /^0\.2\.0-rc\.2 \|\| 0\.2\.1-alpha\.1 \|\| 0\.2\.1-rc\.2$/);
  assert.match(checkOf(report, 'host.version').remediation, /0\.2\.0-rc\.2/);
  assert.match(checkOf(report, 'host.version').remediation, /0\.2\.1-alpha\.1/);
  assert.match(checkOf(report, 'host.version').remediation, /0\.2\.1-rc\.2/);
});

test('a host version that only satisfies the range by build metadata is blocked, not accepted', async () => {
  const dir = scratch('host-metadata');
  const hostRoot = path.join(dir, 'fake-host', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(hostRoot, 'lib'), { recursive: true });
  const version = `${SUPPORTED_DSH_VERSIONS[0]}+unverified`;
  fs.writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }));
  const { home } = freshHome('host-metadata-home');
  const report = await collectDiagnostics(baseOptions(home, { cliPath: path.join(hostRoot, 'lib', 'bin.js') }));
  const check = checkOf(report, 'host.version');
  // `satisfiesRange` ignores build metadata, so the range comparison alone would
  // accept this string; only the exact declared alternatives are verified hosts.
  assert.equal(satisfiesRange(version, check.evidence.supported), true);
  assert.equal(check.evidence.verified, false);
  assert.equal(levelOf(report, 'host.version'), 'blocked');
  assert.equal(exitCodeFor(report), 2);
  assert.match(check.summary, /not one of the versions verified/);
});

test('dependencies on non-public runtime surfaces are degraded, never silently ok', async () => {
  const { home } = freshHome('internal-api');
  const report = await collectDiagnostics(liveOptions(home, { ctx: healthyCtx({ hideInternalApi: true }) }));
  assert.equal(levelOf(report, 'runtime.internal-api'), 'degraded');
  assert.equal(report.status, 'degraded');
  const check = checkOf(report, 'runtime.internal-api');
  assert.ok(check.evidence.unavailable.length >= 3);
  assert.ok(check.evidence.unavailable.some((api) => api.includes('registry.values')));
});

test('a missing required runtime service is blocked', async () => {
  const { home } = freshHome('capability');
  const report = await collectDiagnostics(liveOptions(home, { ctx: healthyCtx({ missingServices: ['storageDomain'] }) }));
  assert.equal(levelOf(report, 'runtime.capabilities'), 'blocked');
  assert.ok(checkOf(report, 'runtime.capabilities').evidence.missingServices.includes('storageDomain'));
});

test('incomplete tool registration is blocked and names the missing tools', async () => {
  const { home } = freshHome('registration');
  const report = await collectDiagnostics(liveOptions(home, { ctx: healthyCtx({ missingTools: ['evolution_measure'] }) }));
  assert.equal(levelOf(report, 'runtime.registration'), 'blocked');
  assert.deepEqual(checkOf(report, 'runtime.registration').evidence.missingTools, ['evolution_measure']);
});

test('cli mode marks live checks not-evaluated instead of guessing', async () => {
  const { home } = freshHome('cli-mode');
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'runtime.capabilities'), 'not-evaluated');
  assert.equal(report.partial, true);
  assert.ok(report.coverage.notEvaluated.length >= 3);
  assert.ok(report.coverage.evaluated.includes('data.root'));
});

// ---------------------------------------------------------------------------
// data + state integrity
// ---------------------------------------------------------------------------

test('damaged failure memory is degraded and recoverable, never a silent loss', async () => {
  const { home, paths } = freshHome('memory-damaged');
  fs.writeFileSync(paths.memoryPath, '{"schema":1,"entries":[{"signature":');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.memory');
  assert.equal(check.level, 'degraded');
  assert.equal(check.recoverable, true);
  assert.match(check.summary, /quarantines it/);
  assert.equal(report.summary.blocked, 0);
});

test('valid failure memory and quarantined evidence are both reported', async () => {
  const { home, paths } = freshHome('memory-ok');
  fs.writeFileSync(paths.memoryPath, JSON.stringify({ schema: 1, entries: [{ signature: 's', count: 1 }] }));
  const first = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(first, 'state.memory'), 'ok');
  assert.equal(checkOf(first, 'state.memory').evidence.entries, 1);
  fs.writeFileSync(path.join(paths.dataRoot, 'evolution-memory.json.quarantine-1-2'), '{"broken"');
  const second = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(second, 'state.memory-quarantine'), 'degraded');
  assert.equal(checkOf(second, 'state.memory-quarantine').recoverable, false);
});

test('a failure memory the runtime quarantines is degraded, matching the runtime predicate', async () => {
  const deep = '{"a":'.repeat(3000) + '1' + '}'.repeat(3000);
  const cases = [
    ['null-record', JSON.stringify({ schema: 1, entries: [null] }), /not an object, or nested too deeply/],
    ['primitive-record', JSON.stringify({ schema: 1, entries: [42] }), /not an object, or nested too deeply/],
    ['array-record', JSON.stringify({ schema: 1, entries: [[]] }), /not an object, or nested too deeply/],
    ['deep-record', `{"schema":1,"entries":[{"id":"deep","payload":${deep}}]}`, /not an object, or nested too deeply/],
    ['unrepresentable-number-record', '{"schema":1,"entries":[{"n":1e400}]}', /not an object, or nested too deeply/],
    ['precision-lost-record', '{"schema":1,"entries":[{"n":9007199254740993}]}', /does not survive JSON.parse exactly/],
    ['duplicate-key-record', '{"schema":1,"entries":[{"p":1,"p":2}]}', /has duplicate keys/],
  ];
  for (const [name, content, expected] of cases) {
    const { home, paths } = freshHome(`memory-${name}`);
    fs.writeFileSync(paths.memoryPath, content);
    const report = await collectDiagnostics(baseOptions(home));
    const check = checkOf(report, 'state.memory');
    assert.equal(check.level, 'degraded', `${name} must be degraded`);
    assert.equal(check.recoverable, true);
    assert.match(check.evidence.problems.join(' '), expected);
    assert.equal(report.summary.blocked, 0);
  }
});

test('a memory file with a UTF-8 BOM is degraded, matching the runtime', async () => {
  const { home, paths } = freshHome('memory-bom');
  fs.writeFileSync(paths.memoryPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schema":1,"entries":[{"p":1}]}')]));
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.memory');
  assert.equal(check.level, 'degraded');
  assert.match(check.evidence.problems.join(' '), /not valid JSON/);
  assert.equal(report.summary.blocked, 0);
});

test('a memory file that is not valid UTF-8 is degraded, matching the runtime', async () => {
  const { home, paths } = freshHome('memory-bad-utf8');
  fs.writeFileSync(paths.memoryPath, Buffer.concat([Buffer.from('{"schema":1,"entries":[{"p":"'), Buffer.from([0xff]), Buffer.from('"}]}')]));
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.memory');
  assert.equal(check.level, 'degraded');
  assert.match(check.evidence.problems.join(' '), /not valid UTF-8/);
  assert.equal(report.summary.blocked, 0);
});

test('domain aggregate: absent ok, corrupt blocked, unreadable-never-rewritten', async () => {
  const absent = freshHome('domain-absent');
  assert.equal(levelOf(await collectDiagnostics(baseOptions(absent.home)), 'state.domain'), 'ok');

  const corrupt = freshHome('domain-corrupt');
  fs.writeFileSync(corrupt.paths.domainGlobalPath, '{"unit":');
  const report = await collectDiagnostics(baseOptions(corrupt.home));
  assert.equal(levelOf(report, 'state.domain'), 'blocked');
  assert.equal(checkOf(report, 'state.domain').recoverable, false);
  assert.equal(fs.readFileSync(corrupt.paths.domainGlobalPath, 'utf8'), '{"unit":');
});

test('domain aggregate fixture matches the runtime schema and tampering is blocked', async () => {
  const { home, paths } = freshHome('domain-schema');
  const global = domainGlobal({ applied: { 'evt-1': 'ab'.repeat(32) } });
  assert.equal(evolutionDomainSpec.global.schema.safeParse(global).success, true);
  writeDomain(paths, global);
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'state.domain'), 'ok');
  assert.equal(checkOf(report, 'state.domain').evidence.applied, 1);

  const tampered = freshHome('domain-tampered');
  writeDomain(tampered.paths, { ...domainGlobal(), schema: 2 });
  const blocked = await collectDiagnostics(baseOptions(tampered.home));
  assert.equal(levelOf(blocked, 'state.domain'), 'blocked');
});

test('a pending domain transaction without its archive is blocked, with the archive it is recoverable', async () => {
  const missing = freshHome('pending-missing');
  writeDomain(missing.paths, domainGlobal({ pending: { stage: 'stage-11111111-2222-3333-4444-555555555555', aggregate: { evolution: { schema: 4 } }, applied: {} } }));
  const blocked = await collectDiagnostics(baseOptions(missing.home));
  assert.equal(levelOf(blocked, 'state.domain'), 'blocked');
  assert.equal(checkOf(blocked, 'state.domain').evidence.pending.state, 'missing-archive');
  assert.match(checkOf(blocked, 'state.domain').remediation, /E_DOMAIN_PENDING_ARCHIVE_MISSING/);

  const present = freshHome('pending-present');
  const stage = 'stage-11111111-2222-3333-4444-555555555555';
  writeDomain(present.paths, domainGlobal({ pending: { stage, aggregate: { evolution: { schema: 4 } }, applied: {} } }));
  fs.mkdirSync(path.join(present.paths.domainStagingDir, stage), { recursive: true });
  const degraded = await collectDiagnostics(baseOptions(present.home));
  assert.equal(levelOf(degraded, 'state.domain'), 'degraded');
  assert.equal(checkOf(degraded, 'state.domain').evidence.pending.state, 'replayable');
});

test('orphan staging recovery is idempotent and refuses while a writer holds the lock', async () => {
  const { home, paths } = freshHome('orphan-staging');
  writeDomain(paths, domainGlobal());
  fs.mkdirSync(path.join(paths.domainStagingDir, 'stage-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), { recursive: true });
  const before = fs.readFileSync(paths.domainGlobalPath, 'utf8');

  const first = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.equal(first.summary.blocked, 0);
  assert.deepEqual(first.repairsApplied.map((entry) => entry.status), ['applied']);
  assert.equal(fs.existsSync(path.join(paths.domainStagingDir, 'stage-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')), false);
  assert.equal(fs.readFileSync(paths.domainGlobalPath, 'utf8'), before, 'repair must not touch the aggregate');

  const second = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(second.repairsApplied, [], 'a repeat repair must have nothing to do');
  assert.equal(fs.readFileSync(paths.domainGlobalPath, 'utf8'), before);

  const locked = freshHome('orphan-staging-locked');
  writeDomain(locked.paths, domainGlobal());
  const stageDir = path.join(locked.paths.domainStagingDir, 'stage-bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(locked.paths.domainArchiveLockPath, String(process.pid));
  const guarded = await collectDiagnostics(baseOptions(locked.home));
  assert.equal(levelOf(guarded, 'state.domain'), 'degraded');
  assert.equal(checkOf(guarded, 'state.domain').evidence.archiveLock.active, true);
  assert.deepEqual(guarded.repairs.filter((repair) => repair.id === 'domain-orphan-staging'), [],
    'no repair may be offered while a live writer holds the archive lock');
  const applied = await applyRepairs([{ id: 'domain-orphan-staging', safe: true }], { paths: locked.paths });
  assert.deepEqual(applied.map((entry) => entry.status), ['skipped']);
  assert.equal(fs.existsSync(stageDir), true, 'a live writer must keep its staging directory');
});

test('event bridge: verified ok, bad MAC blocked, conflicting event id blocked, partial tail repairable', async () => {
  const ok = freshHome('bridge-ok');
  const repeated = JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, sequence: 1 }));
  fs.writeFileSync(ok.paths.eventBridgePath, `${repeated}\n${repeated}\n`);
  const verified = await collectDiagnostics(baseOptions(ok.home));
  assert.equal(levelOf(verified, 'state.event-bridge'), 'ok');
  assert.equal(checkOf(verified, 'state.event-bridge').evidence.duplicateRecords, 1);

  const bad = freshHome('bridge-bad');
  writeBridge(bad.paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }], { corruptMac: true });
  const blocked = await collectDiagnostics(baseOptions(bad.home));
  assert.equal(levelOf(blocked, 'state.event-bridge'), 'blocked');
  assert.equal(checkOf(blocked, 'state.event-bridge').recoverable, false);
  assert.match(checkOf(blocked, 'state.event-bridge').summary, /MAC verification/);

  const conflict = freshHome('bridge-conflict');
  const firstEnvelope = signEventBridgeEnvelope({ eventId: 'evt-9', eventType: 'measurement-completed' }, { key: KEY, sequence: 1 });
  const secondEnvelope = signEventBridgeEnvelope({ eventId: 'evt-9', eventType: 'trial-completed' }, { key: KEY, sequence: 2 });
  fs.writeFileSync(conflict.paths.eventBridgePath, `${JSON.stringify(firstEnvelope)}\n${JSON.stringify(secondEnvelope)}\n`);
  const conflicting = await collectDiagnostics(baseOptions(conflict.home));
  assert.equal(levelOf(conflicting, 'state.event-bridge'), 'blocked');
  assert.equal(checkOf(conflicting, 'state.event-bridge').evidence.conflicts.length, 1);
  assert.equal(checkOf(conflicting, 'state.event-bridge').recoverable, false);

  const tail = freshHome('bridge-tail');
  writeBridge(tail.paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }], { truncateTail: true });
  const stub = await collectDiagnostics(baseOptions(tail.home));
  assert.equal(levelOf(stub, 'state.event-bridge'), 'blocked');
  assert.equal(checkOf(stub, 'state.event-bridge').recoverable, true);
  const repaired = await runDiagnostics({ ...baseOptions(tail.home), repair: true });
  assert.equal(repaired.status, 'healthy', JSON.stringify(repaired.checks.filter((check) => check.level !== 'ok'), null, 2));
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['applied']);
  const trimmed = fs.readFileSync(tail.paths.eventBridgePath, 'utf8');
  const again = await runDiagnostics({ ...baseOptions(tail.home), repair: true });
  assert.deepEqual(again.repairsApplied, []);
  assert.equal(fs.readFileSync(tail.paths.eventBridgePath, 'utf8'), trimmed);
});

// The doctor and the runtime replay must apply one authentication rule. The
// runtime rejection this pins is test/domain-storage/storage.test.js, mode
// 'writer', where a MAC-valid envelope naming another writer throws
// 'E_DOMAIN_EVENT_AUTH'. Here the same log must not be reported ok.
test('event bridge: a MAC-valid record naming another writer is blocked, not verified', async () => {
  const { home, paths } = freshHome('bridge-writer');
  const foreign = signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, writer: 'other-writer', sequence: 1 });
  fs.writeFileSync(paths.eventBridgePath, `${JSON.stringify(foreign)}\n`);
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.checks.filter((entry) => entry.level === 'blocked').map((entry) => entry.id), ['state.event-bridge'],
    'the foreign-writer log itself must be what blocks the report');
  assert.equal(levelOf(report, 'state.event-bridge'), 'blocked');
  const check = checkOf(report, 'state.event-bridge');
  assert.equal(check.recoverable, false, 'a foreign-writer log is not repairable here');
  assert.match(check.summary, /other-writer/, 'the summary must name the offending writer');
  assert.equal(check.evidence.verifiedEvents, 0, 'a foreign-writer record is not a verified event');
  assert.deepEqual(check.evidence.untrustedWriters, [{ line: 1, sequence: 1, writer: 'other-writer' }]);

  // The same file rewritten with a default-writer envelope stays ok: the new
  // gate must not broaden the existing verdict.
  const trusted = signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, sequence: 1 });
  fs.writeFileSync(paths.eventBridgePath, `${JSON.stringify(trusted)}\n`);
  const control = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(control, 'state.event-bridge'), 'ok');
  assert.equal(checkOf(control, 'state.event-bridge').evidence.verifiedEvents, 1);

  // Both envelopes carry a valid MAC; only the writer identity separates them.
  assert.equal(eventBridgeWriterTrusted(verifyEventBridgeEnvelope(foreign, KEY), EVENT_BRIDGE_DEFAULT_WRITER), false);
  assert.equal(eventBridgeWriterTrusted(verifyEventBridgeEnvelope(trusted, KEY), EVENT_BRIDGE_DEFAULT_WRITER), true);
});

test('event bridge with an unusable key is blocked and the key is never replaced', async () => {
  const { home, paths } = freshHome('bridge-key');
  writeBridge(paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }]);
  fs.writeFileSync(paths.keyPath, 'not-a-key');
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'data.key'), 'blocked');
  assert.equal(levelOf(report, 'state.event-bridge'), 'blocked');
  assert.equal(fs.readFileSync(paths.keyPath, 'utf8'), 'not-a-key');
});

test('damaged cold archives are degraded and never rewritten', async () => {
  const { home, paths } = freshHome('archives');
  fs.mkdirSync(paths.archiveDir, { recursive: true });
  fs.writeFileSync(path.join(paths.archiveDir, 'exp-1.md'), '# Evolution experiment exp-1\n');
  fs.writeFileSync(path.join(paths.archiveDir, 'exp-2.md'), 'no header here\n');
  fs.mkdirSync(paths.dockyardDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dockyardDir, 'state.json.evolution-archive.jsonl.segments'), '{"a":1}\n{"b":');
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'state.archives'), 'degraded');
  assert.deepEqual(checkOf(report, 'state.archives').evidence.malformed, ['exp-2.md']);
  assert.equal(fs.readFileSync(path.join(paths.archiveDir, 'exp-2.md'), 'utf8'), 'no header here\n');
});

test('inspectJsonLines distinguishes a complete record from a partial tail', () => {
  const complete = inspectJsonLines('{"a":1}\n{"b":2}\n');
  assert.equal(complete.complete, true);
  assert.equal(complete.truncatedTail, false);
  const partial = inspectJsonLines('{"a":1}\n{"b":');
  assert.equal(partial.complete, false);
  assert.equal(partial.truncatedTail, true);
  assert.equal(partial.invalid.length, 1);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test('a verified import is ok, a tampered import is blocked, and a missing target degrades', async () => {
  const good = freshHome('migration-good');
  validManifest(good.paths, [
    { target: 'legacy-source/preset/knowledge/evolution-memory.json', content: '{"schema":1,"entries":[]}' },
    { target: 'evolution-memory.json', content: '{"schema":1,"entries":[]}' },
  ]);
  const ok = await collectDiagnostics(baseOptions(good.home));
  assert.equal(levelOf(ok, 'migration.manifest'), 'ok');
  assert.match(checkOf(ok, 'migration.manifest').summary, /verified/);

  const tampered = freshHome('migration-tampered');
  const manifest = validManifest(tampered.paths, [{ target: 'legacy-source/preset/knowledge/evolution-memory.json', content: '{"schema":1,"entries":[]}' }]);
  manifest.entries[0].sha256 = 'c'.repeat(64);
  fs.writeFileSync(tampered.paths.migrationManifestPath, JSON.stringify({ schema: 1, importId: manifest.importId, files: manifest.entries, boundaries: [] }));
  const blocked = await collectDiagnostics(baseOptions(tampered.home));
  assert.equal(levelOf(blocked, 'migration.manifest'), 'blocked');
  assert.equal(exitCodeFor(blocked), 2);

  const changed = freshHome('migration-changed');
  validManifest(changed.paths, [{ target: 'legacy-source/preset/knowledge/evolution-memory.json', content: '{"schema":1,"entries":[]}' }]);
  fs.writeFileSync(path.join(changed.paths.dataRoot, 'legacy-source/preset/knowledge/evolution-memory.json'), '{"schema":1,"entries":[1]}');
  const changedReport = await collectDiagnostics(baseOptions(changed.home));
  assert.equal(levelOf(changedReport, 'migration.manifest'), 'blocked');
  assert.match(checkOf(changedReport, 'migration.manifest').summary, /immutable import evidence/);

  const missing = freshHome('migration-missing');
  const built = validManifest(missing.paths, [
    { target: 'legacy-source/preset/knowledge/evolution-memory.json', content: '{"schema":1,"entries":[]}' },
    { target: 'evolution-memory.json', content: '{"schema":1,"entries":[]}' },
  ]);
  fs.rmSync(path.join(missing.paths.dataRoot, 'evolution-memory.json'));
  const degraded = await collectDiagnostics(baseOptions(missing.home));
  assert.equal(levelOf(degraded, 'migration.manifest'), 'degraded');
  assert.equal(built.entries.length, 2);
});

test('an interrupted import keeps its only copy; a published one is cleaned idempotently', async () => {
  const interrupted = freshHome('migration-interrupted');
  const stageDir = `${interrupted.paths.dataRoot}.migration-11111111-2222-3333-4444-555555555555`;
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'evolution-memory.json'), '{}\n');
  const report = await collectDiagnostics(baseOptions(interrupted.home));
  assert.equal(levelOf(report, 'migration.manifest'), 'degraded');
  assert.equal(checkOf(report, 'migration.manifest').recoverable, false);
  assert.equal(report.repairs.length, 0, 'a stage without a manifest is the only copy and must not be deleted');
  const first = await runDiagnostics({ ...baseOptions(interrupted.home), repair: true });
  assert.deepEqual(first.repairsApplied, []);
  assert.equal(fs.existsSync(stageDir), true);

  const published = freshHome('migration-published');
  validManifest(published.paths, [{ target: 'legacy-source/preset/knowledge/evolution-memory.json', content: '{"schema":1,"entries":[]}' }]);
  const publishedStage = `${published.paths.dataRoot}.migration-99999999-2222-3333-4444-555555555555`;
  fs.mkdirSync(publishedStage, { recursive: true });
  const repaired = await runDiagnostics({ ...baseOptions(published.home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['applied']);
  assert.equal(fs.existsSync(publishedStage), false);
  const again = await runDiagnostics({ ...baseOptions(published.home), repair: true });
  assert.deepEqual(again.repairsApplied, []);
  assert.equal(levelOf(again, 'migration.manifest'), 'ok');
});

// ---------------------------------------------------------------------------
// promotion
// ---------------------------------------------------------------------------

test('promotion journal states are classified: none, incomplete, canary, committed, rollback-failed, unknown', async () => {
  const none = freshHome('promotion-none');
  assert.equal(levelOf(await collectDiagnostics(baseOptions(none.home)), 'promotion.journal'), 'ok');
  assert.equal(checkOf(await collectDiagnostics(baseOptions(none.home)), 'promotion.journal').evidence.state, 'not-executed');

  const canary = freshHome('promotion-canary');
  writeJournal(canary.paths, { phase: 'canary-observing' });
  const canaryReport = await collectDiagnostics(baseOptions(canary.home));
  assert.equal(levelOf(canaryReport, 'promotion.journal'), 'degraded');
  assert.equal(checkOf(canaryReport, 'promotion.journal').evidence.state, 'canary-observing');
  assert.equal(canaryReport.repairs.some((repair) => repair.id.startsWith('promotion-journal')), false);

  const failed = freshHome('promotion-rollback-failed');
  writeJournal(failed.paths, { phase: 'rollback-failed' });
  const failedReport = await runDiagnostics({ ...baseOptions(failed.home), repair: true });
  assert.equal(levelOf(failedReport, 'promotion.journal'), 'blocked');
  assert.equal(checkOf(failedReport, 'promotion.journal').evidence.state, 'rollback-failed');
  assert.equal(checkOf(failedReport, 'promotion.journal').recoverable, false);
  assert.equal(fs.existsSync(path.join(failed.paths.promotionStateDir, 'journal.json')), true, 'fail-safe: never touch an unknown rollback');

  const unknown = freshHome('promotion-unknown');
  writeJournal(unknown.paths, { phase: 'something-new' });
  const unknownReport = await collectDiagnostics(baseOptions(unknown.home));
  assert.equal(levelOf(unknownReport, 'promotion.journal'), 'blocked');
  assert.equal(checkOf(unknownReport, 'promotion.journal').evidence.state, 'state-unknown');

  const unreadable = freshHome('promotion-unreadable');
  fs.mkdirSync(unreadable.paths.promotionStateDir, { recursive: true });
  fs.writeFileSync(path.join(unreadable.paths.promotionStateDir, 'journal.json'), '{oops');
  const unreadableReport = await collectDiagnostics(baseOptions(unreadable.home));
  assert.equal(levelOf(unreadableReport, 'promotion.journal'), 'blocked');
  assert.equal(checkOf(unreadableReport, 'promotion.journal').evidence.state, 'state-unknown');

  const leftover = freshHome('promotion-leftover');
  fs.mkdirSync(path.join(leftover.paths.promotionStateDir, 'backups'), { recursive: true });
  const leftoverReport = await collectDiagnostics(baseOptions(leftover.home));
  // The orchestrator's `promotionStateKnown()` throws on this same state, so
  // the plugin does not start; `degraded` would claim it still works.
  assert.equal(levelOf(leftoverReport, 'promotion.journal'), 'blocked');
  assert.equal(checkOf(leftoverReport, 'promotion.journal').evidence.state, 'state-unknown');
  assert.equal(checkOf(leftoverReport, 'promotion.journal').recoverable, false);
  assert.equal(leftoverReport.repairs.some((repair) => repair.id.startsWith('promotion-journal')), false);
  assert.deepEqual(fs.readdirSync(leftover.paths.promotionStateDir), ['backups'], 'the doctor never moves or deletes unclassifiable state');
});

test('interrupted promotion rolls back from the journal and the repair is idempotent', async () => {
  const { home, paths } = freshHome('promotion-recover');
  const { records } = fileChangeJournal(paths, { phase: 'committing' });
  const fileRecords = records.filter((record) => record.type === 'file');
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'promotion.journal'), 'degraded');
  assert.equal(checkOf(report, 'promotion.journal').evidence.phase, 'committing');
  assert.match(checkOf(report, 'promotion.journal').summary, /interrupted/);

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['applied']);
  for (const record of fileRecords) {
    if (record.existed) assert.equal(fs.readFileSync(record.target, 'utf8'), record.before, `rollback must restore ${record.target}`);
    else assert.equal(fs.existsSync(record.target), false, `rollback must remove the new ${record.target}`);
  }
  assert.equal(fs.existsSync(records[records.length - 1].target), false, 'the half-created plugin directory is removed');
  assert.equal(fs.existsSync(paths.promotionStateDir), false);
  assert.equal(repaired.status, 'healthy', JSON.stringify(repaired.checks.filter((check) => check.level === 'degraded' || check.level === 'blocked'), null, 2));

  const again = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(again.repairsApplied, []);
  for (const record of fileRecords) {
    if (record.existed) assert.equal(fs.readFileSync(record.target, 'utf8'), record.before);
    else assert.equal(fs.existsSync(record.target), false);
  }
});

test('a committed promotion cleans its journal without touching the composition', async () => {
  const { home, paths } = freshHome('promotion-committed');
  const promoted = writePromotedPlugin(paths, 'aaaaaaaaaaaa');
  writeComposition(paths, [promoted.row]);
  writeJournal(paths, { phase: 'stable-committed' });
  fs.writeFileSync(paths.evolutionPath, `\n## experiment pointer\n- last experiment: exp-test-1 (stable)\n- durable capability: dsh-evolution-promoted-aaaaaaaaaaaa (${promoted.dir})\n- rollback: remove composition row evolution-promoted-aaaaaaaaaaaa, remove ${promoted.dir}, and start a new session\n`);
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'promotion.journal'), 'degraded');
  assert.equal(levelOf(report, 'promotion.composition'), 'ok');
  assert.equal(levelOf(report, 'promotion.pointer'), 'ok');
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['applied']);
  assert.equal(fs.existsSync(paths.promotionStateDir), false);
  assert.equal(fs.readFileSync(paths.compositionPath, 'utf8').includes(promoted.row.id), true);
  assert.equal(fs.existsSync(promoted.modulePath), true);
  assert.equal(repaired.status, 'healthy');
});

test('promotion repair is refused while a live process holds the promotion lock', async () => {
  const { home, paths } = freshHome('promotion-locked');
  fileChangeJournal(paths, { phase: 'prepared' });
  const compositionBefore = fs.readFileSync(paths.compositionPath, 'utf8');
  fs.mkdirSync(paths.promotionLockPath, { recursive: true });
  fs.writeFileSync(path.join(paths.promotionLockPath, 'lock.json'), JSON.stringify({ schema: 1, pid: process.pid, hostname: os.hostname(), operation: 'promotion', createdAt: new Date().toISOString() }));
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(checkOf(report, 'promotion.journal').evidence.lock.active, true);
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['skipped']);
  assert.equal(fs.existsSync(path.join(paths.promotionStateDir, 'journal.json')), true);
  assert.equal(fs.readFileSync(paths.compositionPath, 'utf8'), compositionBefore);
});

test('a journal that escapes its configured roots is blocked and never applied', () => {
  const { paths } = freshHome('promotion-boundary');
  const outside = path.join(os.tmpdir(), 'not-managed');
  assert.match(checkJournalBoundary({ stateDir: outside, records: [] }, paths), /outside the configured promotion state directory/);
  assert.match(checkJournalBoundary({ stateDir: paths.promotionStateDir, records: [{ type: 'path', target: outside }] }, paths), /outside the configured roots/);
  assert.match(checkJournalBoundary({ stateDir: paths.promotionStateDir, records: [{ type: 'file', target: paths.evolutionPath, backup: '../escape.bak' }] }, paths), /bare file name/);
  assert.equal(checkJournalBoundary({ stateDir: paths.promotionStateDir, records: [{ type: 'path', target: path.join(paths.pluginRoot, 'x') }] }, paths), null);
});

test('out-of-boundary composition rows and dangling rows are blocked; orphan directories degrade', async () => {
  const outside = freshHome('composition-outside');
  writeComposition(outside.paths, [{ id: 'evolution-promoted-aaaaaaaaaaaa', name: 'file:///tmp/elsewhere/lib/index.js' }]);
  const outsideReport = await collectDiagnostics(baseOptions(outside.home));
  assert.equal(levelOf(outsideReport, 'promotion.composition'), 'blocked');
  assert.equal(exitCodeFor(outsideReport), 2);

  const dangling = freshHome('composition-dangling');
  const row = { id: 'evolution-promoted-bbbbbbbbbbbb', name: `file://${path.join(dangling.paths.pluginRoot, 'dsh-evolution-promoted-bbbbbbbbbbbb', 'lib', 'index.js')}` };
  writeComposition(dangling.paths, [row]);
  const danglingReport = await collectDiagnostics(baseOptions(dangling.home));
  assert.equal(levelOf(danglingReport, 'promotion.composition'), 'blocked');
  assert.match(danglingReport.checks.find((check) => check.id === 'promotion.composition').summary, /missing/);

  const orphan = freshHome('composition-orphan');
  writePromotedPlugin(orphan.paths, 'cccccccccccc');
  const orphanReport = await collectDiagnostics(baseOptions(orphan.home));
  assert.equal(levelOf(orphanReport, 'promotion.composition'), 'degraded');
  assert.deepEqual(checkOf(orphanReport, 'promotion.composition').evidence.orphanDirs, ['dsh-evolution-promoted-cccccccccccc']);
});

test('migrated legacy pointers are reported as intentionally inactive, not as failures', async () => {
  const { home, paths } = freshHome('pointer-legacy');
  validManifest(paths, [{ target: 'legacy-source/preset/EVOLUTION.md', content: 'legacy\n' }]);
  fs.writeFileSync(paths.evolutionPath, [
    '',
    '## 实验指针',
    '- last experiment: exp-legacy-1 (canary-observing)',
    '- durable capability: dsh-evolution-promoted-b6aa678ea063 ($HOME/.dsh/plugins/dsh-evolution-promoted-b6aa678ea063)',
    '- rollback: remove composition row evolution-promoted-b6aa678ea063, remove $HOME/.dsh/plugins/dsh-evolution-promoted-b6aa678ea063, then start a new session',
    '',
  ].join('\n'));
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'promotion.pointer'), 'ok');
  assert.equal(checkOf(report, 'promotion.pointer').evidence.intentionallyInactive, true);
  assert.equal(report.summary.blocked, 0);
});

// ---------------------------------------------------------------------------
// profile composition + CLI
// ---------------------------------------------------------------------------

test('parseComposedProfile reads bundle sections and entry state', () => {
  const dump = [
    '# == @deepseek-ai/dsh-base',
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '# == dsh-evolution',
    '- id: evolution-orchestrator',
    '  name: dsh-evolution',
    '- id: evolution-trust-root-guard',
    '  name: dsh-evolution/guard',
    '  inject:',
    '    - tools',
    '',
  ].join('\n');
  const parsed = parseComposedProfile(dump);
  assert.deepEqual(parsed.titles, ['@deepseek-ai/dsh-base', 'dsh-evolution']);
  assert.equal(parsed.sections.get('dsh-evolution').entries.length, 2);
  assert.equal(parsed.sections.get('dsh-evolution').entries[0].name, 'dsh-evolution');
});

test('a composed profile missing the bundle entries is blocked', async () => {
  const { home } = freshHome('composition-missing');
  const report = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout: '# == dsh-evolution\n', stderr: '' }) },
  }));
  assert.equal(levelOf(report, 'host.composition'), 'blocked');
  assert.deepEqual(checkOf(report, 'host.composition').evidence.problems, [
    'evolution-orchestrator entry is absent',
    'evolution-trust-root-guard entry is absent',
  ]);
});

test('a composed profile without the bundle layer is blocked', async () => {
  const { home } = freshHome('composition-no-layer');
  const report = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout: '# == @deepseek-ai/dsh-base\n- id: tools\n  name: tools\n', stderr: '' }) },
  }));
  assert.equal(levelOf(report, 'host.composition'), 'blocked');
  assert.ok(checkOf(report, 'host.composition').evidence.problems.some((problem) => problem.includes('no dsh-evolution layer')));
});

test('a profile that cannot compose is blocked with the CLI stderr tail', async () => {
  const { home } = freshHome('composition-error');
  const report = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 1, stdout: '', stderr: 'Error: Cannot find module\n  at x\n', error: null }) },
  }));
  assert.equal(levelOf(report, 'host.composition'), 'blocked');
  assert.deepEqual(checkOf(report, 'host.composition').evidence.stderr, ['Error: Cannot find module', '  at x']);
});

test('a disabled bundle entry is blocked', async () => {
  const { home } = freshHome('composition-disabled');
  const report = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout: '# == dsh-evolution\n- id: evolution-orchestrator\n  name: dsh-evolution\n  disabled: true\n- id: evolution-trust-root-guard\n  name: dsh-evolution/guard\n', stderr: '' }) },
  }));
  assert.equal(levelOf(report, 'host.composition'), 'blocked');
  assert.ok(checkOf(report, 'host.composition').evidence.problems.some((problem) => problem.includes('disabled')));
});

// The official CLI splits a bundle into two sections when a profile patch
// targets it. Looking the layer up by raw title used to report such a healthy
// install as blocked.
test('a profile patched by the user keeps one merged dsh-evolution layer and stays ok', async () => {
  const { home } = freshHome('composition-patched');
  const stdout = composedDump({ patchTitle: 'dsh-evolution, patched by /tmp/x/cordis.patch.yml', writer: 'custom-writer' });
  const parsed = parseComposedProfile(stdout);
  assert.deepEqual(parsed.titles, ['dsh-evolution, patched by /tmp/x/cordis.patch.yml', 'dsh-evolution']);
  const section = parsed.sections.get('dsh-evolution');
  assert.equal(section.entries.length, 2, 'both sections merge into one layer');
  assert.deepEqual(section.rawTitles, ['dsh-evolution, patched by /tmp/x/cordis.patch.yml', 'dsh-evolution']);
  assert.equal(section.patched, true);
  assert.deepEqual(composedEventBridgeWriter(parsed), { writer: 'custom-writer', unreadable: false });

  const report = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout, stderr: '' }) },
  }));
  const composition = checkOf(report, 'host.composition');
  assert.equal(composition.level, 'ok', JSON.stringify(composition.evidence.problems));
  assert.equal(composition.evidence.patched, true);
  assert.deepEqual(composition.evidence.sectionTitles, ['dsh-evolution, patched by /tmp/x/cordis.patch.yml', 'dsh-evolution']);
});

test('a patched profile that still lacks an entry is blocked with the unchanged message', async () => {
  const { home } = freshHome('composition-patched-missing');
  const stdout = composedDump({ patchTitle: 'dsh-evolution, patched by /tmp/x/cordis.patch.yml', includeGuard: false });
  const report = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout, stderr: '' }) },
  }));
  assert.equal(levelOf(report, 'host.composition'), 'blocked');
  assert.deepEqual(checkOf(report, 'host.composition').evidence.problems, ['evolution-trust-root-guard entry is absent']);
  assert.match(checkOf(report, 'host.composition').summary, /missing 1 required bundle entry/);
});

// A composed writer is only read from the entry's own `config:` block, as a
// direct child line, named exactly `eventBridgeWriter`, stated exactly once,
// and only when its scalar can be recovered verbatim. A nested key is ignored
// (it is not this key); a non-canonical spelling of it is unreadable (the
// runtime would bind it). Anything else keeps the three states apart instead
// of guessing, so the doctor can never verify the log against a writer the
// runtime does not use.
const writerState = (dump) => composedEventBridgeWriter(parseComposedProfile(dump));
const wrote = (state) => (state.unreadable === false && typeof state.writer === 'string' ? state.writer : null);

test('a composed writer is read only from the direct, unique, readable key', () => {
  assert.deepEqual(writerState(''), { writer: null, unreadable: false }, 'no layer at all');
  assert.deepEqual(writerState('# == dsh-evolution\n'), { writer: null, unreadable: false }, 'no entries');
  assert.deepEqual(writerState('# == dsh-evolution\n- id: evolution-trust-root-guard\n  name: dsh-evolution/guard\n'), { writer: null, unreadable: false }, 'no orchestrator entry');
  assert.deepEqual(writerState(orchestratorDump([])), { writer: null, unreadable: false }, 'no config key at all');
  assert.deepEqual(writerState(orchestratorDump(['  config:'])), { writer: null, unreadable: false }, 'an empty config mapping');

  // Plain and quoted strings are kept verbatim.
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer'])), { writer: 'custom-writer', unreadable: false });
  assert.deepEqual(writerState(orchestratorDump(['  config:', "    eventBridgeWriter: 'custom-writer'"])), { writer: 'custom-writer', unreadable: false }, 'single quotes');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: "custom-writer"'])), { writer: 'custom-writer', unreadable: false }, 'double quotes');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: " padded "'])), { writer: ' padded ', unreadable: false }, 'a quoted scalar keeps its inner spaces');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter:   custom-writer   '])), { writer: 'custom-writer', unreadable: false }, 'a plain scalar is trimmed');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: CUSTOM-Writer'])), { writer: 'CUSTOM-Writer', unreadable: false }, 'value case is preserved');

  // A colon or a hash is part of the value unless a comment could start there.
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: writer:scope'])), { writer: 'writer:scope', unreadable: false });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: "writer: scope"'])), { writer: 'writer: scope', unreadable: false });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: writer#scope'])), { writer: 'writer#scope', unreadable: false });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: "writer # scope"'])), { writer: 'writer # scope', unreadable: false });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: writer # comment'])), { writer: null, unreadable: true, reason: 'inline-comment-ambiguous' });

  // A nested `other.eventBridgeWriter` is a different key, whichever side of
  // the direct key it appears on.
  assert.deepEqual(
    writerState(orchestratorDump(['  config:', '    other:', '      eventBridgeWriter: nested-writer', '    eventBridgeWriter: custom-writer'])),
    { writer: 'custom-writer', unreadable: false }, 'nested key before the direct key');
  assert.deepEqual(
    writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer', '    other:', '      eventBridgeWriter: nested-writer'])),
    { writer: 'custom-writer', unreadable: false }, 'nested key after the direct key');

  // Indentation decides which key is the entry's own config and which is a child.
  assert.deepEqual(writerState(orchestratorDump(['  writer: custom-writer', '  config:'])), { writer: null, unreadable: false }, 'a `writer` sibling of `config` is not the key');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '  eventBridgeWriter: custom-writer'])), { writer: null, unreadable: false }, 'a key at the same indent as `config:` is not a child');
  assert.deepEqual(
    writerState(['# == dsh-evolution', '- id: evolution-orchestrator', '  name: dsh-evolution', '  extra:', '    config:', '      eventBridgeWriter: nested-writer', '- id: evolution-trust-root-guard', '  name: dsh-evolution/guard', '']),
    { writer: null, unreadable: false }, '`extra.config` is not the entry config');
  assert.deepEqual(
    writerState(['# == dsh-evolution', '- id: evolution-orchestrator', '  name: dsh-evolution', '- id: other-entry', '  config:', '    eventBridgeWriter: custom-writer', '']),
    { writer: null, unreadable: false }, 'a config on another entry says nothing about this one');

  // Blank lines inside a block mapping do not end it: the reader keeps
  // scanning and reads the key that follows them.
  assert.deepEqual(
    writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer', '', '    other: 1'])),
    { writer: 'custom-writer', unreadable: false }, 'blank line after the key');
  assert.deepEqual(
    writerState(orchestratorDump(['  config:', '', '    eventBridgeWriter: custom-writer'])),
    { writer: 'custom-writer', unreadable: false }, 'blank line before the key');

  // Key spelling is matched verbatim: a case variant or another name is a
  // different YAML key and says nothing about this one, so it stays undeclared.
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    EventBridgeWriter: custom-writer'])), { writer: null, unreadable: false }, 'case variant');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    otherKey: custom-writer'])), { writer: null, unreadable: false }, 'another key name');

  // A non-canonical spelling of the same key resolves to `eventBridgeWriter`
  // when YAML parses it, so the runtime would bind that value. Reading it as
  // "undeclared" would default the expectation the runtime does not use, so it
  // is unreadable instead — never undeclared, never a guessed value.
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    "eventBridgeWriter": custom-writer'])), { writer: null, unreadable: true, reason: 'non-canonical-key' }, 'double-quoted key name');
  assert.deepEqual(writerState(orchestratorDump(['  config:', "    'eventBridgeWriter': custom-writer"])), { writer: null, unreadable: true, reason: 'non-canonical-key' }, 'single-quoted key name');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter : custom-writer'])), { writer: null, unreadable: true, reason: 'non-canonical-key' }, 'space before the colon');

  // The verbatim key next to a non-canonical spelling of the same key is the
  // same YAML key twice: which one the loader keeps is not guessed.
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer', '    "eventBridgeWriter": other-writer'])), { writer: null, unreadable: true, reason: 'duplicate-key' }, 'verbatim key next to a non-canonical spelling');
  assert.deepEqual(writerState(orchestratorDump(['  config:', "    'eventBridgeWriter': custom-writer", '    eventBridgeWriter : other-writer'])), { writer: null, unreadable: true, reason: 'duplicate-key' }, 'two non-canonical spellings of the key');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer', '    eventBridgeWriter: other-writer'])), { writer: null, unreadable: true, reason: 'duplicate-key' }, 'the key twice');
  assert.deepEqual(writerState(['# == dsh-evolution', '- id: evolution-orchestrator', '  name: dsh-evolution', '- id: evolution-orchestrator', '  name: dsh-evolution', '  config:', '    eventBridgeWriter: custom-writer', ''].join('\n')), { writer: null, unreadable: true, reason: 'duplicate-entry' }, 'the entry twice');
});

test('a composed writer the dump does not state exactly is unreadable, not guessed', () => {
  assert.deepEqual(writerState(orchestratorDump(['  config: { eventBridgeWriter: custom-writer }'])), { writer: null, unreadable: true, reason: 'inline-config' }, 'inline flow map');
  assert.deepEqual(writerState(orchestratorDump(['  config: [custom-writer]'])), { writer: null, unreadable: true, reason: 'inline-config' }, 'inline flow seq');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: !!js process.env.WRITER'])), { writer: null, unreadable: true, reason: 'yaml-tag' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: !!str custom-writer'])), { writer: null, unreadable: true, reason: 'yaml-tag' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: ${process.env.WRITER}'])), { writer: null, unreadable: true, reason: 'template' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: {{ writer }}'])), { writer: null, unreadable: true, reason: 'template' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: &anchor custom-writer'])), { writer: null, unreadable: true, reason: 'yaml-anchor' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: *anchor'])), { writer: null, unreadable: true, reason: 'yaml-anchor' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: |', '      custom-writer'])), { writer: null, unreadable: true, reason: 'block-scalar' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: "custom\\nwriter"'])), { writer: null, unreadable: true, reason: 'escaped-quote-value' }, 'a double-quoted backslash escape');
  assert.deepEqual(writerState(orchestratorDump(['  config:', "    eventBridgeWriter: 'it''s-writer'"])), { writer: null, unreadable: true, reason: 'escaped-single-quote' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: "custom-writer'])), { writer: null, unreadable: true, reason: 'unterminated-quote' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: true'])), { writer: null, unreadable: true, reason: 'non-string-scalar' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: null'])), { writer: null, unreadable: true, reason: 'non-string-scalar' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: 42'])), { writer: null, unreadable: true, reason: 'non-string-scalar' });
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: 2024-01-01'])), { writer: null, unreadable: true, reason: 'non-string-scalar' }, 'a date is not a writer name');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter:'])), { writer: null, unreadable: false }, 'a bare key is YAML null, which the runtime reads as the default');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: ""'])), { writer: null, unreadable: false }, 'an empty string is falsy for the runtime, so it is the default');
  assert.deepEqual(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer', '  config:', '    eventBridgeWriter: other-writer'])), { writer: null, unreadable: true, reason: 'duplicate-config-key' }, 'two config keys in one entry');
  assert.equal(wrote(writerState(orchestratorDump(['  config:', '    eventBridgeWriter: custom-writer']))), 'custom-writer');
});

test('the doctor expects the writer the composed profile configures, matching the runtime', async () => {
  const stdout = composedDump({ writer: 'custom-writer' });
  const probe = { runDumpConfig: () => ({ status: 0, stdout, stderr: '' }) };

  // The log this installation writes under the bundle default is exactly what
  // the runtime replay rejects with E_DOMAIN_EVENT_AUTH.
  const foreign = freshHome('writer-composition-default-log');
  writeBridge(foreign.paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }]);
  const blocked = await collectDiagnostics(baseOptions(foreign.home, { profile: 'web', probe }));
  const check = checkOf(blocked, 'state.event-bridge');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.writerSource, 'composition');
  assert.equal(check.evidence.trustedWriter, 'custom-writer');
  assert.deepEqual(check.evidence.untrustedWriters, [{ line: 1, sequence: 1, writer: EVENT_BRIDGE_DEFAULT_WRITER }]);
  assert.match(check.summary, /name a writer other than custom-writer/);
  assert.match(check.remediation, /only trusts `custom-writer` \(composition\)/);

  const accepted = freshHome('writer-composition-custom-log');
  fs.writeFileSync(accepted.paths.eventBridgePath, `${JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, writer: 'custom-writer', sequence: 1 }))}\n`);
  const ok = await collectDiagnostics(baseOptions(accepted.home, { profile: 'web', probe }));
  assert.equal(levelOf(ok, 'state.event-bridge'), 'ok');
  assert.equal(checkOf(ok, 'state.event-bridge').evidence.writerSource, 'composition');
  assert.match(checkOf(ok, 'state.event-bridge').summary, /verified against the trusted writer `custom-writer` \(composition\)/);
});

test('without a composed writer the doctor uses the bundle default, and an explicit config wins', async () => {
  const { home, paths } = freshHome('writer-default');
  writeBridge(paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }]);

  const composed = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout: composedDump(), stderr: '' }) },
  }));
  assert.equal(levelOf(composed, 'state.event-bridge'), 'ok');
  assert.equal(checkOf(composed, 'state.event-bridge').evidence.writerSource, 'bundle-default');
  assert.equal(checkOf(composed, 'state.event-bridge').evidence.trustedWriter, EVENT_BRIDGE_DEFAULT_WRITER);

  const skipped = await collectDiagnostics(baseOptions(home));
  assert.equal(checkOf(skipped, 'state.event-bridge').evidence.writerSource, 'bundle-default');

  const explicit = await collectDiagnostics(baseOptions(home, {
    profile: 'web',
    probe: { runDumpConfig: () => ({ status: 0, stdout: composedDump({ writer: 'custom-writer' }), stderr: '' }) },
    config: { eventBridgeWriter: 'in-session-writer' },
  }));
  assert.equal(checkOf(explicit, 'state.event-bridge').evidence.writerSource, 'config');
  assert.equal(checkOf(explicit, 'state.event-bridge').evidence.trustedWriter, 'in-session-writer');
});

// The in-session expectation is the runtime's own expression, byte for byte:
// `config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER` (`lib/domain-storage.js`).
// It is not trimmed, never falls back to the composed profile, and a falsy value
// (including an empty string) lands on the bundle default exactly as it does in
// the replay path.
test('an in-session config writer follows the runtime expression exactly', async () => {
  const runtimeWriter = (config) => config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;
  const { home, paths } = freshHome('writer-config-parity');
  // Signed with the padded writer, so the log only verifies under that exact value.
  fs.writeFileSync(paths.eventBridgePath, `${JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, writer: ' custom-writer ', sequence: 1 }))}\n`);
  const composition = composedDump({ writer: 'composition-writer' });
  const diagnose = (config) => collectDiagnostics(baseOptions(home, { profile: 'web', probe: { runDumpConfig: () => ({ status: 0, stdout: composition, stderr: '' }) }, config }));

  const padded = await diagnose({ eventBridgeWriter: ' custom-writer ' });
  assert.equal(checkOf(padded, 'state.event-bridge').evidence.trustedWriter, ' custom-writer ');
  assert.equal(checkOf(padded, 'state.event-bridge').evidence.trustedWriter, runtimeWriter({ eventBridgeWriter: ' custom-writer ' }));
  assert.equal(checkOf(padded, 'state.event-bridge').evidence.writerSource, 'config', 'an explicit config never falls back to the composition');
  assert.equal(levelOf(padded, 'state.event-bridge'), 'ok', 'the untrimmed value is what the log was signed with');

  const empty = await diagnose({ eventBridgeWriter: '' });
  assert.equal(checkOf(empty, 'state.event-bridge').evidence.trustedWriter, EVENT_BRIDGE_DEFAULT_WRITER);
  assert.equal(checkOf(empty, 'state.event-bridge').evidence.trustedWriter, runtimeWriter({ eventBridgeWriter: '' }));
  assert.equal(checkOf(empty, 'state.event-bridge').evidence.writerSource, 'config');

  const absent = await diagnose({});
  assert.equal(checkOf(absent, 'state.event-bridge').evidence.trustedWriter, runtimeWriter({}));
  assert.equal(checkOf(absent, 'state.event-bridge').evidence.writerSource, 'config', 'a present config with no writer still does not fall back');

  const numeric = await diagnose({ eventBridgeWriter: 42 });
  assert.equal(checkOf(numeric, 'state.event-bridge').evidence.trustedWriter, runtimeWriter({ eventBridgeWriter: 42 }));
  assert.equal(levelOf(numeric, 'state.event-bridge'), 'blocked', 'a non-string expectation can never match a string writer, exactly as the runtime rejects it');
  assert.deepEqual(checkOf(numeric, 'state.event-bridge').evidence.untrustedWriters, [{ line: 1, sequence: 1, writer: ' custom-writer ' }]);

  const trimmed = await collectDiagnostics(baseOptions(home, { profile: 'web', probe: { runDumpConfig: () => ({ status: 0, stdout: composition, stderr: '' }) }, config: { eventBridgeWriter: 'custom-writer' } }));
  assert.equal(checkOf(trimmed, 'state.event-bridge').evidence.trustedWriter, 'custom-writer');
  assert.equal(levelOf(trimmed, 'state.event-bridge'), 'blocked', 'the untrimmed log is not accepted under the trimmed expectation');
});

// A composition that does not state the value must not be defaulted: verifying
// the log against the bundle default would report a verdict the runtime may not
// share. The log still gets its MAC-level checks, and the verdict degrades with
// the writers actually seen in it.
test('an unreadable composed writer degrades the verdict instead of defaulting it', async () => {
  const { home, paths } = freshHome('writer-unknown');
  fs.writeFileSync(paths.eventBridgePath, `${JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, writer: 'custom-writer', sequence: 1 }))}\n`);
  const stdout = orchestratorDump(['  config:', '    eventBridgeWriter: ${process.env.WRITER}']);
  const report = await collectDiagnostics(baseOptions(home, { profile: 'web', probe: { runDumpConfig: () => ({ status: 0, stdout, stderr: '' }) } }));
  const check = checkOf(report, 'state.event-bridge');
  assert.equal(check.level, 'degraded', 'the only thing wrong here is the unreadable expectation, not a MAC-level problem');
  assert.equal(check.evidence.writerSource, 'unknown');
  assert.equal(check.evidence.trustedWriter, null);
  assert.equal(check.evidence.writerExpectationReason, 'template');
  assert.deepEqual(check.evidence.writersSeen, ['custom-writer'], 'the writers actually in the log are listed for a human to judge');
  assert.deepEqual(check.evidence.untrustedWriters, [], 'no record is called untrusted against a writer that was never read');
  assert.equal(check.evidence.verifiedEvents, 1, 'the MAC-level verdict still runs');
  assert.match(check.summary, /trusted writer could not be read/);
  assert.match(check.remediation, /Make the configured writer readable/);
  assert.equal(report.repairs.some((repair) => repair.id === 'event-bridge-trim-partial-tail'), false);
});

// The same degradation applies to a key the dump spells non-canonically: the
// runtime would bind it, so the doctor must not fall back to the bundle
// default and report a verdict the runtime does not share.
test('a non-canonically spelled composed writer degrades the verdict instead of defaulting it', async () => {
  for (const [name, keyLine] of [['double quotes', '    "eventBridgeWriter": custom-writer'], ['single quotes', "    'eventBridgeWriter': custom-writer"], ['space before colon', '    eventBridgeWriter : custom-writer']]) {
    const { home, paths } = freshHome(`writer-non-canonical-${name.replace(/\s+/g, '-')}`);
    fs.writeFileSync(paths.eventBridgePath, `${JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, writer: 'custom-writer', sequence: 1 }))}\n`);
    const stdout = orchestratorDump(['  config:', keyLine]);
    const report = await collectDiagnostics(baseOptions(home, { profile: 'web', probe: { runDumpConfig: () => ({ status: 0, stdout, stderr: '' }) } }));
    const check = checkOf(report, 'state.event-bridge');
    assert.equal(check.level, 'degraded', `${name}: the writer is not the bundle default, so the verdict cannot be defaulted`);
    assert.equal(check.evidence.writerSource, 'unknown', name);
    assert.equal(check.evidence.trustedWriter, null, name);
    assert.equal(check.evidence.writerExpectationReason, 'non-canonical-key', name);
    assert.deepEqual(check.evidence.writersSeen, ['custom-writer'], name);
    assert.deepEqual(check.evidence.untrustedWriters, [], name);
    assert.equal(check.evidence.verifiedEvents, 1, `${name}: the MAC-level verdict still runs`);
    assert.match(check.summary, /trusted writer could not be read/, name);
  }
});

test('an unreadable composed writer still reports MAC-level problems as blocked', async () => {
  const { home, paths } = freshHome('writer-unknown-blocked');
  writeBridge(paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }], { corruptMac: true });
  const stdout = orchestratorDump(['  config:', '    eventBridgeWriter: !!js process.env.WRITER']);
  const report = await collectDiagnostics(baseOptions(home, { profile: 'web', probe: { runDumpConfig: () => ({ status: 0, stdout, stderr: '' }) } }));
  const check = checkOf(report, 'state.event-bridge');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.writerSource, 'unknown');
  assert.equal(check.evidence.untrustedWriters.length, 0);
  assert.match(check.summary, /fail MAC verification/);
});

// The repair plan is derived from one read; acting on it later without
// re-establishing its condition deletes whatever the tail became meanwhile.
test('an expired partial-tail repair is skipped instead of deleting a trusted event', async () => {
  const { home, paths } = freshHome('repair-expired');
  writeBridge(paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }], { truncateTail: true });
  const planned = await collectDiagnostics(baseOptions(home));
  const repair = checkOf(planned, 'state.event-bridge').repair;
  assert.equal(repair.id, 'event-bridge-trim-partial-tail');

  const first = JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, sequence: 1 }));
  const trusted = JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-2', eventType: 'measurement-completed' }, { key: KEY, sequence: 2 }));
  const replaced = `${first}\n${trusted}`;
  fs.writeFileSync(paths.eventBridgePath, replaced);

  const applied = await applyRepairs([repair], { paths });
  assert.deepEqual(applied.map((entry) => entry.status), ['skipped']);
  assert.match(applied[0].detail, /no longer matches the plan/);
  assert.equal(fs.readFileSync(paths.eventBridgePath, 'utf8'), replaced, 'the trusted event must survive byte for byte');
});

// The bridge file's writers hold no lock, so the repair is check-then-act. The
// re-read before the rename closes the window that covers the preparation; an
// append that lands inside it must leave the file untouched. `fs.fsyncSync` is
// the last call between the snapshot and the re-read, so hooking it puts the
// concurrent append exactly in that window (controlled scheduling, no sleep).
test('a partial-tail repair whose file grew while it was prepared writes nothing', async () => {
  const { home, paths } = freshHome('repair-raced');
  writeBridge(paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }], { truncateTail: true });
  const planned = await collectDiagnostics(baseOptions(home));
  const repair = checkOf(planned, 'state.event-bridge').repair;
  assert.equal(repair.id, 'event-bridge-trim-partial-tail');

  // A concurrent writer appends one complete trusted event (the runtime writes
  // `${envelope}\n` with O_APPEND), which lands after the unterminated tail.
  const appended = `${JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-2', eventType: 'measurement-completed' }, { key: KEY, sequence: 2 }))}\n`;
  const realFsync = fs.fsyncSync;
  let raced = null;
  fs.fsyncSync = (fd) => {
    if (raced === null) {
      fs.writeFileSync(paths.eventBridgePath, `${fs.readFileSync(paths.eventBridgePath, 'utf8')}${appended}`);
      raced = fs.readFileSync(paths.eventBridgePath, 'utf8');
    }
    return realFsync(fd);
  };
  let applied;
  try {
    applied = await applyRepairs([repair], { paths });
  } finally {
    fs.fsyncSync = realFsync;
  }

  assert.notEqual(raced, null, 'the hook must have fired; otherwise the test proves nothing');
  assert.deepEqual(applied.map((entry) => entry.status), ['skipped']);
  assert.match(applied[0].detail, /changed while the replacement was prepared/);
  assert.equal(fs.readFileSync(paths.eventBridgePath, 'utf8'), raced, 'the file must keep the bytes the concurrent writer produced');
  assert.ok(fs.readFileSync(paths.eventBridgePath, 'utf8').includes(appended), 'the trusted event must survive');
  assert.equal(fs.existsSync(`${paths.eventBridgePath}.${process.pid}.trim.tmp`), false, 'the prepared temp file must be removed');

  // Control: with no concurrent writer the same plan is applied, so the only
  // difference above is the re-read.
  fs.writeFileSync(paths.eventBridgePath, fs.readFileSync(paths.eventBridgePath, 'utf8').replace(appended, ''));
  const again = await applyRepairs([repair], { paths });
  assert.deepEqual(again.map((entry) => entry.status), ['applied']);
});

// A single unterminated record has no verified prefix to keep, so the trim is
// not offered at all; the remediation says so instead of promising a repair.
test('a partial tail with no complete line is not offered as a repair', async () => {
  const { home, paths } = freshHome('repair-no-prefix');
  fs.writeFileSync(paths.eventBridgePath, '{"schema":2,"writer":"dsh-evolution');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.event-bridge');
  assert.equal(check.level, 'blocked');
  assert.equal(check.recoverable, false);
  assert.equal(check.repair, undefined);
  assert.equal(report.repairs.some((repair) => repair.id === 'event-bridge-trim-partial-tail'), false);
  assert.deepEqual(check.evidence.malformed.map((entry) => entry.line), [1]);
  assert.match(check.remediation, /no verified complete prefix to keep/);

  // The repair path keeps its own depth-of-defence skip for an empty prefix.
  const applied = await applyRepairs([{ id: 'event-bridge-trim-partial-tail', safe: true }], { paths });
  assert.deepEqual(applied.map((entry) => entry.status), ['skipped']);
  assert.equal(fs.readFileSync(paths.eventBridgePath, 'utf8'), '{"schema":2,"writer":"dsh-evolution', 'nothing may be written');
});

test('a partial-tail repair that still matches is applied and keeps the trusted prefix', async () => {
  const { home, paths } = freshHome('repair-matching');
  const withTail = writeBridge(paths, [{ eventId: 'evt-1', eventType: 'measurement-completed' }], { truncateTail: true });
  const planned = await collectDiagnostics(baseOptions(home));
  const repair = checkOf(planned, 'state.event-bridge').repair;
  const applied = await applyRepairs([repair], { paths });
  assert.deepEqual(applied.map((entry) => entry.status), ['applied']);
  assert.match(applied[0].detail, /re-verified/);
  const kept = fs.readFileSync(paths.eventBridgePath, 'utf8');
  assert.equal(kept, withTail.slice(0, withTail.lastIndexOf('\n') + 1));
  assert.equal(inspectJsonLines(kept).complete, true);
});

test('the cli writes nothing and reports exit codes that match the classification', () => {
  const { home } = freshHome('cli-contract');
  const before = fs.readdirSync(home, { recursive: true }).sort();
  const healthy = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'doctor.mjs'), '--home', home, '--no-composition', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  assert.ok([0, 1, 2].includes(healthy.status), `unexpected exit code ${healthy.status}: ${healthy.stderr}`);
  const parsed = JSON.parse(healthy.stdout);
  assert.equal(parsed.schema, 1);
  assert.ok(Array.isArray(parsed.checks));
  assert.equal(parsed.status === 'blocked' ? 2 : parsed.status === 'degraded' ? 1 : 0, healthy.status);
  assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before, 'read-only diagnostics must not create or remove files');

  fs.writeFileSync(path.join(home, 'storages', 'evolution', 'execution-events.jsonl'), `${JSON.stringify(signEventBridgeEnvelope({ eventId: 'evt-1', eventType: 'measurement-completed' }, { key: KEY, sequence: 1 }))}\n{"schema":2,"writer":"dsh-evolution`);
  const beforeRepair = fs.readFileSync(path.join(home, 'storages', 'evolution', 'execution-events.jsonl'), 'utf8');
  const repaired = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'doctor.mjs'), '--home', home, '--no-composition', '--repair', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(repaired.status, 0, repaired.stdout);
  const afterRepair = fs.readFileSync(path.join(home, 'storages', 'evolution', 'execution-events.jsonl'), 'utf8');
  assert.notEqual(afterRepair, beforeRepair);
  assert.equal(inspectJsonLines(afterRepair).complete, true);
  const second = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'doctor.mjs'), '--home', home, '--no-composition', '--repair', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stdout);
  assert.equal(fs.readFileSync(path.join(home, 'storages', 'evolution', 'execution-events.jsonl'), 'utf8'), afterRepair, 'a repeat repair must be a no-op');
  assert.deepEqual(JSON.parse(second.stdout).repairsApplied, []);
  assert.equal(JSON.parse(second.stdout).status, 'healthy');
});

// ---------------------------------------------------------------------------
// profile detection
// ---------------------------------------------------------------------------

test('profile detection picks the profile that lists the bundle and flags unusable installs', async () => {
  const { detectProfile } = await import('../scripts/doctor.mjs');
  const home = scratch('detect');
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles', 'headless'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  fs.writeFileSync(path.join(home, 'profiles', 'headless', 'package.json'), JSON.stringify({ name: 'dsh-profile-headless', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-evolution'] } } }));
  const detected = detectProfile({ dshHome: home });
  assert.equal(detected.profile, 'headless');
  assert.equal(detected.source, 'detected');
  assert.deepEqual(detected.withBundle, ['headless']);

  fs.writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-evolution'] } } }));
  const several = detectProfile({ dshHome: home });
  assert.equal(several.source, 'detected-first-of-several');
  assert.deepEqual(several.withBundle, ['headless', 'web']);

  const none = detectProfile({ dshHome: scratch('detect-empty') });
  assert.equal(none.profile, null);
  assert.equal(none.source, 'no-profiles-directory');

  fs.mkdirSync(path.join(home, 'profiles', 'tui'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'tui', 'package.json'), JSON.stringify({ name: 'dsh-profile-tui', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  fs.rmSync(path.join(home, 'profiles', 'headless'), { recursive: true });
  fs.rmSync(path.join(home, 'profiles', 'web'), { recursive: true });
  const report = await collectDiagnostics(baseOptions(home, { profileCandidates: ['tui'] }));
  assert.equal(levelOf(report, 'host.install'), 'degraded');
  assert.match(checkOf(report, 'host.install').summary, /No profile under \$DSH_HOME\/profiles lists dsh-evolution/);
});

test('a stale domain archive lock is reported and repaired idempotently, never stolen from a live owner', async () => {
  const { home, paths } = freshHome('stale-lock');
  writeDomain(paths, domainGlobal());
  fs.writeFileSync(paths.domainArchiveLockPath, '');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(paths.domainArchiveLockPath, past, past);
  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(levelOf(report, 'state.domain'), 'degraded');
  assert.equal(checkOf(report, 'state.domain').evidence.staleLock, true);
  assert.ok(report.repairs.some((repair) => repair.id === 'domain-stale-lock'));

  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied.map((entry) => entry.status), ['applied']);
  assert.equal(fs.existsSync(paths.domainArchiveLockPath), false);
  const again = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(again.repairsApplied, []);
  assert.equal(levelOf(again, 'state.domain'), 'ok');

  fs.writeFileSync(paths.domainArchiveLockPath, String(process.pid));
  const live = await collectDiagnostics(baseOptions(home));
  assert.equal(checkOf(live, 'state.domain').evidence.archiveLock.active, true);
  assert.deepEqual(live.repairs.filter((repair) => repair.id === 'domain-stale-lock'), []);
  assert.equal(fs.readFileSync(paths.domainArchiveLockPath, 'utf8'), String(process.pid));
});

test('the doctor CLI is reachable through a symlinked path', () => {
  const { home } = freshHome('symlink-cli');
  const linkRoot = scratch('symlink-root');
  const link = path.join(linkRoot, 'link');
  fs.symlinkSync(repoRoot, link, 'dir');
  const result = spawnSync(process.execPath, [path.join(link, 'scripts', 'doctor.mjs'), '--home', home, '--no-composition', '--json'], { cwd: linkRoot, encoding: 'utf8' });
  assert.ok([0, 1, 2].includes(result.status), `unexpected exit ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schema, 1);
  assert.ok(parsed.checks.some((check) => check.id === 'data.root'));
});
