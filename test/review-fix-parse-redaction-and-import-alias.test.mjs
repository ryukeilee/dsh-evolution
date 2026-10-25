// Regressions for the two remaining review findings:
//   * a native JSON parse message embeds a quoted excerpt of the parsed bytes,
//     and those bytes reach warnings and doctor evidence; the excerpt is user
//     data and must be projected out.
//   * the migration source/destination guard compared lexical paths, so a
//     symlinked source root (macOS /tmp) let the import write into the snapshot
//     it is only allowed to read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, recoverInterruptedPromotion, redactJsonParseMessage } from '../lib/orchestrator.js';
import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { orchestratorContext } from './orchestrator-durability-fixtures.mjs';
import { importEvolutionData } from '../scripts/import-evolution-data.mjs';

const SECRET = 'sk-live-TOPSECRET-0123456789';

async function scratch(t, name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `evo-parse-${name}-`));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

const exists = (target) => fsp.access(target).then(() => true, () => false);

test('a parse-failure message loses the quoted input excerpt and keeps its structure', () => {
  // V8 quotes a truncated excerpt of the parsed bytes, e.g.
  //   Unexpected token 's', "sk-live-TO"... is not valid JSON
  // The excerpt is the durable file's own content.
  const excerpt = 'Unexpected token \'s\', "sk-live-TO"... is not valid JSON';
  const projected = redactJsonParseMessage(excerpt);
  assert.equal(projected.includes('sk-live-TO'), false);
  assert.equal(/"\.\.\. is not valid JSON/.test(projected), false);
  assert.match(projected, /Unexpected token 's'/);
  assert.match(projected, /is not valid JSON/);

  const positioned = "Expected ',' or '}' after property value in JSON at position 33 (line 1 column 34)";
  assert.equal(redactJsonParseMessage(positioned), positioned, 'a message without an excerpt is unchanged');
  assert.equal(redactJsonParseMessage(''), 'invalid JSON');
});

test('an unreadable promotion journal does not echo its bytes into the error or the doctor report', async (t) => {
  const root = await scratch(t, 'journal');
  const paths = resolveEvolutionPaths({ dshHome: root });
  await fsp.mkdir(paths.promotionStateDir, { recursive: true });
  // A bare token makes V8 quote the file content in its message.
  await fsp.writeFile(path.join(paths.promotionStateDir, 'journal.json'), `${SECRET} trailing`);

  await assert.rejects(recoverInterruptedPromotion(paths), (error) => {
    // Pre-fix the message read: ... "sk-live-TO"... is not valid JSON.
    assert.equal(error.message.includes('sk-live-TO'), false, 'the runtime error must not carry the journal bytes');
    assert.match(error.message, /Evolution promotion journal is unreadable/);
    return true;
  });

  const report = await collectDiagnostics({ paths, home: true, probe: { skipComposition: true } });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('sk-live-TO'), false, 'the doctor report must not carry the journal bytes');
  const check = report.checks.find((candidate) => candidate.id === 'promotion.journal');
  assert.equal(check.level, 'blocked');
});

test('a corrupted evolution-memory.json warning does not echo the file bytes', async (t) => {
  const root = await scratch(t, 'memory');
  const memoryPath = path.join(root, 'evolution-memory.json');
  await fsp.writeFile(memoryPath, `${SECRET} broken`);
  const core = new EvolutionOrchestrator(orchestratorContext(), {
    presetDir: root, startupDrift: false, memoryPath,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
  });
  const warnings = core.memory.diagnostics().warnings.join('\n');
  assert.match(warnings, /parse failure/);
  assert.equal(warnings.includes('sk-live-TO'), false, 'the queryable warning must not carry the file bytes');
});

async function migrationFixture(t, name) {
  const root = await scratch(t, name);
  const source = path.join(root, 'source');
  await fsp.mkdir(path.join(source, 'knowledge', 'archive', '2026', 'experiments'), { recursive: true });
  await fsp.writeFile(path.join(source, 'knowledge', 'evolution-memory.json'), JSON.stringify({ schema: 1, entries: [{ id: 'existing' }] }));
  await fsp.writeFile(path.join(source, 'EVOLUTION.md'), '# Existing protocol\n');
  await fsp.writeFile(path.join(source, 'knowledge', 'archive', '2026', 'experiments', 'exp-1.md'), '# Experiment 1\n');
  const alias = path.join(root, 'source-alias');
  await fsp.symlink(source, alias, 'dir');
  return { root, source, alias };
}

test('a symlinked source root cannot steer the import destination inside the snapshot', async (t) => {
  const { source, alias } = await migrationFixture(t, 'import-alias');
  const inside = path.join(source, 'migrated');
  // `path.resolve(alias) + "/migrated"` is lexically outside the source; only the
  // filesystem identity shows that it writes into the snapshot.
  await assert.rejects(
    importEvolutionData({ presetSnapshot: alias, destination: inside }),
    /Destination must be outside the source snapshot/,
  );
  assert.equal(await exists(inside), false, 'the refused import wrote nothing into the source');
  assert.deepEqual((await fsp.readdir(source)).sort(), ['EVOLUTION.md', 'knowledge']);
});

test('a real destination outside the symlinked source still imports', async (t) => {
  const { root, alias } = await migrationFixture(t, 'import-control');
  const destination = path.join(root, 'destination');
  const result = await importEvolutionData({ presetSnapshot: alias, destination });
  assert.equal(result.status, 'imported');
  assert.equal(await exists(path.join(destination, 'evolution-memory.json')), true);
});
