// Boundary regressions closed in the quality round.
//
//   * the composition guard resolved only the first argument of a direct fs write,
//     so `copyFile`/`rename`/`link`/`symlink` into the Cordis trust root passed;
//   * it only descended into nested commands (`sh -c`, `xargs`, `node -e`) when the
//     outer text mentioned "cordis", so a symlink alias hid the target;
//   * the managed bookkeeping exemption matched the lexical path only, so an alias
//     inside `.task-ledger/` authorized a write to a credential file;
//   * the doctor's YAML check echoed the parser message, which quotes the
//     configuration file, into the CLI report and the tool result;
//   * a leftover import staging directory was offered as a "safe" repair even when
//     a target recorded by the manifest was missing, so applying it could delete
//     the only remaining copy;
//   * a failed cold-archive compaction deleted the archives of collections the
//     transaction had not touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

import {
  codeMutatesComposition,
  commandMutatesComposition,
  isVerifiedManagedTransaction,
} from '../lib/guard.js';
import { collectDiagnostics, runDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { EvolutionMemory } from '../lib/dockyard-domain/memory.js';
import { JsonStateStore } from './dockyard-domain/support.js';

const TRUST_ROOT = '/srv/app/node_modules/@deepseek-ai/cordis';

function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `evo-quality-boundary-${name}-`));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

test('fs copy, rename, link and symlink are judged by their destination', () => {
  const denied = [
    `fs.copyFileSync('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
    `fs.promises.rename('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
    `fs.linkSync('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
    `fs.symlinkSync('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
    `fs.copyFileSync('${TRUST_ROOT}/lib/index.js', '/tmp/input.js')`,
    // The bracket form is the same API; the destination argument, not the call
    // syntax, is what the guard has to resolve.
    `fs["copyFileSync"]('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
    `fs['renameSync']('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
    `fs.promises["symlinkSync"]('/tmp/input.js', '${TRUST_ROOT}/lib/index.js')`,
  ];
  for (const code of denied) assert.equal(codeMutatesComposition(code), true, code);
  const allowed = [
    `fs.copyFileSync('/tmp/input.js', '/tmp/output.js')`,
    `fs.renameSync('/tmp/a.js', '/tmp/b.js')`,
    `fs.writeFileSync('/tmp/output.js', 'x')`,
  ];
  for (const code of allowed) assert.equal(codeMutatesComposition(code), false, code);
});

test('a nested command is analyzed even when the outer text names no trust root', () => {
  const root = scratch('guard-alias');
  const trust = path.join(root, '@deepseek-ai', 'cordis');
  fs.mkdirSync(path.join(trust, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(trust, 'lib', 'index.js'), '// cordis');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(trust, alias);
  const written = `cp /tmp/input.js ${alias}/lib/index.js`;
  assert.equal(commandMutatesComposition(written), true, 'the resolved target is the trust root');
  assert.equal(commandMutatesComposition(`sh -c '${written}'`), true);
  assert.equal(commandMutatesComposition(`bash -c '${written}'`), true);
  const nodeCode = `fs.writeFileSync('${alias}/lib/index.js','x')`;
  assert.equal(commandMutatesComposition(`node -e ${JSON.stringify(nodeCode)}`), true);
  assert.equal(commandMutatesComposition(`sh -c ${JSON.stringify(`node -e ${JSON.stringify(nodeCode)}`)}`), true);
  assert.equal(commandMutatesComposition(`sh -c 'cp /tmp/input.js /tmp/output.js'`), false);
});

test('the managed exemption does not follow a symlink out of its own scope', () => {
  const root = scratch('guard-managed');
  fs.mkdirSync(path.join(root, '.task-ledger'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  const alias = path.join(root, '.task-ledger', 'entry');
  fs.symlinkSync(path.join(root, '.env'), alias);
  const context = { verified: true, transactionType: 'evolution-managed', actor: 'dsh-evolution', ownership: 'evolution', operation: 'write' };
  const escaping = { name: 'write', arguments: { file_path: alias }, operationContext: context, context };
  assert.equal(isVerifiedManagedTransaction(escaping), false, 'the resolved target is a credential file, not bookkeeping');

  const honest = path.join(root, '.task-ledger', 'journal.json');
  fs.writeFileSync(honest, '{}');
  const bookkeeping = { name: 'write', arguments: { file_path: honest }, operationContext: context, context };
  assert.equal(isVerifiedManagedTransaction(bookkeeping), true, 'a real bookkeeping write keeps its exemption');
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const KEY = 'a'.repeat(64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function freshHome(name) {
  const home = scratch(name);
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  return { home, paths };
}

function baseOptions(home) {
  return { home: true, dshHome: home, probe: { skipComposition: true } };
}

const checkOf = (report, id) => report.checks.find((check) => check.id === id);

test('an invalid composition report withholds the configuration excerpt', async () => {
  const { home, paths } = freshHome('yaml');
  // A secret on a positional line is not a shape the credential redaction rules
  // recognize, so only withholding the excerpt keeps it out of the report.
  fs.writeFileSync(paths.compositionPath, '- id: evolution-promoted-000000000000\n  config:\n    password: SECRET123\n  name: [\n');
  const report = await collectDiagnostics(baseOptions(home));
  const check = checkOf(report, 'promotion.composition');
  assert.equal(check.level, 'blocked');
  assert.equal(JSON.stringify(report).includes('SECRET123'), false, 'the report never carries the document');
  assert.match(String(check.evidence.error), /line \d+/);
  assert.equal(JSON.stringify(check.evidence).includes('password'), false);
});

test('no parser reason echoes the document, however the tag was written', async () => {
  // Both shapes carry the tag's own text into the parser's `reason`: the
  // `!<...>` form and the one whose tag name is plain words. A character-class
  // filter cannot tell the second from a structural reason, so the report uses a
  // fixed category and the parser's position only.
  for (const [name, document, secret] of [
    ['yaml-tag', 'value: !<SYNTHETIC_PRIVATE_VALUE> hello\n', 'SYNTHETIC_PRIVATE_VALUE'],
    ['yaml-tag-words', 'value: !<SYNTHETIC PRIVATE VALUE> hello\n', 'SYNTHETIC PRIVATE VALUE'],
    ['yaml-indent', '- id: evolution-promoted-000000000000\n  config:\n    password: SYNTHETIC_PRIVATE_VALUE\n  name: [\n', 'SYNTHETIC_PRIVATE_VALUE'],
  ]) {
    const { home, paths } = freshHome(name);
    fs.writeFileSync(paths.compositionPath, document);
    const report = await collectDiagnostics(baseOptions(home));
    const check = checkOf(report, 'promotion.composition');
    assert.equal(check.level, 'blocked', name);
    assert.equal(JSON.stringify(report).includes(secret), false, `${name}: the document never reaches the report`);
    assert.match(String(check.evidence.error), /^invalid YAML \(line \d+, column \d+\)$/, name);
  }
});

test('a staged import is not offered for cleanup when a target is missing', async () => {
  const { home, paths } = freshHome('migration');
  const entries = [{ target: 'legacy-source/preset/knowledge/evolution-memory.json', content: '{"schema":1,"entries":[]}' },
    { target: 'evolution-memory.json', content: '{"schema":1,"entries":[]}' }];
  const recorded = entries.map((file) => {
    const target = path.join(paths.dataRoot, file.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    return { target: file.target, sha256: sha256(file.content), bytes: Buffer.byteLength(file.content) };
  }).sort((left, right) => left.target.localeCompare(right.target));
  fs.writeFileSync(paths.migrationManifestPath, JSON.stringify({
    schema: 1,
    importId: sha256(JSON.stringify(recorded)),
    importedAt: new Date().toISOString(),
    files: recorded,
  }));
  const stage = `${paths.dataRoot}.migration-11111111-2222-3333-4444-555555555555`;
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'evolution-memory.json'), '{"schema":1,"entries":[]}');
  // The published target disappears; the staged copy is now the only one left.
  fs.rmSync(path.join(paths.dataRoot, 'evolution-memory.json'));

  const report = await collectDiagnostics(baseOptions(home));
  assert.equal(checkOf(report, 'migration.manifest').recoverable, false);
  assert.deepEqual(report.repairs, [], 'a missing target makes the staging directory evidence, not garbage');
  const repaired = await runDiagnostics({ ...baseOptions(home), repair: true });
  assert.deepEqual(repaired.repairsApplied, []);
  assert.equal(fs.existsSync(stage), true, 'the only remaining copy is preserved');
});

// ---------------------------------------------------------------------------
// cold archive compaction
// ---------------------------------------------------------------------------

function observation(payload) {
  return {
    type: 'tool/error',
    id: payload.id,
    eventId: payload.eventId,
    problem: payload.problem,
    componentId: payload.componentId,
    severity: 'error',
    recordedAt: '2026-10-01T00:00:00.000Z',
  };
}

test('a failed compaction removes the segment directory it installed', async () => {
  const root = scratch('compact-segments');
  const store = path.join(root, '.dockyard-dsh');
  const stateStore = new JsonStateStore({ home: root });
  const first = new EvolutionMemory({ stateStore, maxEntries: 1, archiveMaxBytes: 1024 * 1024, mutationAuthority: { assertMutation() {} } });
  await first.load();
  for (let index = 0; index < 4; index += 1) {
    await first.recordObservation(observation({ id: `obs-${index}`, eventId: `ev-${index}`, problem: `alpha ${index}`, componentId: `plugin:alpha-${index}` }));
  }
  const archiveFile = path.join(store, 'state.json.observations-archive.jsonl');
  const before = fs.readFileSync(archiveFile, 'utf8');
  assert.equal(fs.existsSync(path.join(store, 'state.json.observations-archive.jsonl.segments')), false, 'the first compaction kept one active archive file');

  // A much smaller segment target makes the next compaction stage a segment
  // directory that did not exist before, so the rollback has nothing to restore
  // there but still has to remove what this attempt installed.
  const second = new EvolutionMemory({ stateStore, maxEntries: 1, archiveMaxBytes: 256, mutationAuthority: { assertMutation() {} } });
  await second.load();
  const originalRename = fsp.rename;
  let fired = false;
  fsp.rename = async (from, to) => {
    if (!fired && String(to).endsWith('observations-archive.jsonl') && String(to).startsWith(store)) {
      fired = true;
      throw Object.assign(new Error('INJECTED_INSTALL_FAILURE'), { code: 'EIO' });
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(second.compact(), /INJECTED_INSTALL_FAILURE/);
  } finally {
    fsp.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(fired, true);
  assert.equal(fs.readFileSync(archiveFile, 'utf8'), before, 'the previous archive file is restored byte for byte');
  const segments = path.join(store, 'state.json.observations-archive.jsonl.segments');
  const left = fs.existsSync(segments) ? fs.readdirSync(segments) : [];
  assert.deepEqual(left, [], 'the segment directory this attempt installed is gone again');
});

test('a failed compaction leaves the archives of untouched collections intact', async (t) => {
  const root = scratch('compact');
  const store = path.join(root, '.dockyard-dsh');
  const stateStore = new JsonStateStore({ home: root });
  const memory = new EvolutionMemory({ stateStore, maxEntries: 1, mutationAuthority: { assertMutation() {} } });
  await memory.load();
  // Several collections with cold rows, so a compaction has more than one archive
  // installation to perform.
  await memory.recordObservation(observation({ id: 'obs-a1', eventId: 'ev-a1', problem: 'alpha one', componentId: 'plugin:alpha' }));
  await memory.recordObservation(observation({ id: 'obs-a2', eventId: 'ev-a2', problem: 'alpha two', componentId: 'plugin:alpha' }));
  await memory.recordDiagnosis({ id: 'diag-1', type: 'tool/error', componentId: 'plugin:alpha', failureMode: 'alpha', rootCause: 'beta' });
  await memory.recordDiagnosis({ id: 'diag-2', type: 'tool/error', componentId: 'plugin:alpha', failureMode: 'alpha', rootCause: 'gamma' });
  await memory.compact();
  const archives = fs.readdirSync(store).filter((name) => name.endsWith('-archive.jsonl')).sort();
  assert.ok(archives.length >= 2, `a compaction leaves one archive per collection, saw ${archives.join(', ')}`);
  const before = new Map(archives.map((name) => [name, fs.readFileSync(path.join(store, name), 'utf8')]));

  // Fail the final installation of the *first* staged archive, after its original
  // moved into the backup: every later collection was never touched by this
  // transaction. The pre-fix cleanup deleted every staged path, including the
  // originals it had not moved yet.
  const originalRename = fsp.rename;
  let fired = false;
  fsp.rename = async (from, to) => {
    // The first rename whose destination is an archive path is the installation
    // of the first staged collection. The rollback renames the backup back onto
    // the same path, so only the first one may throw.
    if (!fired && String(to).endsWith('-archive.jsonl') && String(to).startsWith(store)) {
      fired = true;
      throw Object.assign(new Error('INJECTED_INSTALL_FAILURE'), { code: 'EIO' });
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(memory.compact(), /INJECTED_INSTALL_FAILURE/);
  } finally {
    fsp.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(fired, true, 'the failure landed on the first archive installation');
  for (const [name, bytes] of before) {
    const file = path.join(store, name);
    assert.equal(fs.existsSync(file), true, `${name} still exists`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, `${name} keeps exactly its bytes`);
  }
});
