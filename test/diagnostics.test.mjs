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
  parseComposedProfile, EVOLUTION_TOOL_NAMES, SUPPORTED_DSH_VERSIONS,
} from '../lib/diagnostics.js';
import { signEventBridgeEnvelope } from '../lib/orchestrator.js';
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
  // Every version in the declared range is verified by a real install run; see
  // COMPATIBILITY.md. This test keeps the declaration and the code in step.
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '0.2.0-rc.2 || 0.2.1-alpha.1');
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
  assert.match(checkOf(report, 'host.version').evidence.supported, /^0\.2\.0-rc\.2 \|\| 0\.2\.1-alpha\.1$/);
  assert.match(checkOf(report, 'host.version').remediation, /0\.2\.0-rc\.2/);
  assert.match(checkOf(report, 'host.version').remediation, /0\.2\.1-alpha\.1/);
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

test('a failure memory whose records are not objects is degraded, matching the runtime quarantine', async () => {
  const { home, paths } = freshHome('memory-record-damaged');
  fs.writeFileSync(paths.memoryPath, JSON.stringify({ schema: 1, entries: [null] }));
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'state.memory');
  assert.equal(check.level, 'degraded');
  assert.equal(check.recoverable, true);
  assert.match(check.evidence.problems.join(' '), /not an object/);
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
  assert.equal(levelOf(leftoverReport, 'promotion.journal'), 'degraded');
  assert.equal(checkOf(leftoverReport, 'promotion.journal').evidence.state, 'unknown');
  assert.equal(checkOf(leftoverReport, 'promotion.journal').recoverable, false);
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
