// Review blocker B (P1): the rollback path projected the *file* failure through
// `safeErrorDto` but wrote the official Include's `refresh()` failure straight
// from `error.message`:
//
//   journal.json      -> {"target":"...promoted.cordis.yml","error":"refresh password=review-refresh-secret"}
//   exp-*.failure.json -> the same text, because the sidecar serialized the
//                         whole preserved marker without re-projecting it.
//
// Both durable journal boundaries now read one projection: a rollback failure is
// stored as `target` + the safe error fields (category, digest, redacted
// summary), `journal.json` keeps its recovery plan, and the sidecar keeps only
// the diagnosis an operator needs. The scene is still preserved: the journal
// directory, the phase, the exit codes and the failing targets stay readable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, readJournal, exists,
  HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const REFRESH_SECRET = 'review-refresh-secret';
const REFRESH_ERROR = `refresh password=${REFRESH_SECRET}`;

const OBSERVATION = {
  solvesProblem: true,
  errorChange: 'decreased',
  metrics: { errors: 0 },
  beforeMetrics: { errors: 1 },
  afterMetrics: { errors: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'measured',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'clean',
};

function runner() {
  let installed = false;
  return {
    snapshot: () => (installed ? [{ pluginId: 'review-plugin', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'review-plugin', packageId: 'review-package' }; },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => { installed = false; return { ok: true }; },
    undefine: async () => ({ ok: true }),
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
  };
}

/** A measured experiment whose commit window can be edited from the outside. */
async function measuredFixture(t, name, { refresh } = {}) {
  const root = await scratchRoot(name);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = refresh ? { ...unitPromotionRuntime(), refresh } : unitPromotionRuntime();
  await fs.writeFile(paths.compositionPath, '[]\n');
  const ctx = orchestratorContext([]);
  ctx.dynamicCordisRunner = runner();
  const core = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  const exec = execFor('review-owner');
  const proposal = core.propose({ why: 'review-cas', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  await core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec);
  core.measure({ experimentId: proposal.experimentId, observation: OBSERVATION }, exec);
  const archive = path.join(paths.archiveDir, `${proposal.experimentId}.md`);
  await fs.mkdir(paths.archiveDir, { recursive: true });
  return { root, paths, core, exec, experimentId: proposal.experimentId, archive };
}

/** Edit the experiment archive inside the commit window, after the prepare digests. */
async function commitWithExternalEdit(paths, core, exec, experimentId, archive, external) {
  const originalWriteFile = fs.writeFile;
  let injected = false;
  fs.writeFile = async function injectedWriteFile(file, ...rest) {
    if (!injected && String(file).startsWith(paths.pluginRoot) && String(file).endsWith('.tmp')) {
      injected = true;
      await originalWriteFile.call(this, archive, external);
    }
    return originalWriteFile.call(this, file, ...rest);
  };
  let error;
  try {
    await core.promote({ experimentId, confirmation: true }, exec);
  } catch (caught) {
    error = caught;
  } finally {
    fs.writeFile = originalWriteFile;
  }
  assert.ok(error, 'the promotion was refused');
  assert.equal(injected, true, 'the concurrent edit happened inside the commit window');
  return error;
}

function assertSafeFailureRow(failure, where) {
  assert.equal(typeof failure.target, 'string', `${where}: the failed target is still locatable`);
  assert.equal(typeof failure.errorCategory, 'string', `${where}: the failure keeps a category`);
  assert.ok(failure.errorCategory.length > 0, `${where}: the category is not empty`);
  assert.match(failure.errorDigest, /^sha256:[0-9a-f]{16}$/, `${where}: the failure keeps an irreversible digest`);
  assert.equal(typeof failure.errorSummary, 'string', `${where}: the failure keeps a bounded summary`);
  assert.equal(Object.hasOwn(failure, 'error'), false, `${where}: no raw provider text under "error"`);
}

test('a sensitive refresh() failure is projected at both persisted journal boundaries', async (t) => {
  const refresh = async () => { throw new Error(REFRESH_ERROR); };
  const { paths, core, exec, experimentId, archive } = await measuredFixture(t, 'review-refresh-projection', { refresh });
  await fs.writeFile(archive, 'PREPARE BASELINE\n');
  const external = 'EXTERNAL EDIT MUST SURVIVE\n';

  const error = await commitWithExternalEdit(paths, core, exec, experimentId, archive, external);
  assert.match(error.message, /rollback failed/, 'the refusal still reports the preserved journal');
  assert.equal(await fs.readFile(archive, 'utf8'), external, 'the external edit is preserved byte for byte');

  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  const journalText = await fs.readFile(journalFile, 'utf8');
  const journal = JSON.parse(journalText);
  assert.equal(journalText.includes(REFRESH_SECRET), false, 'journal.json must not persist the refresh credential');
  assert.match(journalText, /password=\[redacted\]/, 'the assignment survives with its value redacted');
  assert.equal(journal.phase, 'rollback-failed', 'the journal still says what state the scene is in');
  assert.ok(Array.isArray(journal.records) && journal.records.length > 0, 'the recovery plan is still in the journal');
  const journalRows = journal.rollbackFailures;
  assert.ok(Array.isArray(journalRows) && journalRows.length === 2, JSON.stringify(journalRows));
  for (const row of journalRows) assertSafeFailureRow(row, 'journal.json');

  // The provider's own failure is still identifiable: same target, same
  // irreversible digest over the raw text, and no way back to the text.
  const refreshRow = journalRows.find((row) => row.target === paths.compositionPath);
  assert.ok(refreshRow, `journal.json records the refresh target: ${JSON.stringify(journalRows)}`);
  assert.equal(refreshRow.errorDigest, safeErrorDto(new Error(REFRESH_ERROR), 'rollback').errorDigest, 'the digest is computed on the raw provider text');
  assert.equal(refreshRow.errorSummary.includes('[redacted]'), true, `the summary is redacted: ${refreshRow.errorSummary}`);
  const casRow = journalRows.find((row) => row.target === archive);
  assert.ok(casRow, 'the CAS target is still recorded');
  assert.match(casRow.errorSummary, /CAS conflict/, `the CAS reason survives redaction: ${casRow.errorSummary}`);

  const evidenceFile = path.join(paths.archiveDir, `${experimentId}.failure.json`);
  assert.equal(await exists(evidenceFile), true, 'the failure sidecar is still written');
  const evidenceText = await fs.readFile(evidenceFile, 'utf8');
  assert.equal(evidenceText.includes(REFRESH_SECRET), false, 'the sidecar must not persist the refresh credential');
  assert.match(evidenceText, /password=\[redacted\]/, 'the sidecar keeps the redacted assignment');
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.preservedArchive, archive);
  assert.equal(evidence.promotionJournal.preserved, true);
  assert.equal(evidence.promotionJournal.phase, 'rollback-failed', 'the sidecar keeps the phase');
  assert.equal(evidence.promotionJournal.stateDir, paths.promotionStateDir, 'the sidecar keeps the journal directory');
  assert.equal(evidence.promotionJournal.journalPath, journalFile, 'the sidecar points at the preserved journal');
  assert.equal(Object.hasOwn(evidence.promotionJournal, 'records'), false, 'the sidecar does not serialize the raw journal');
  assert.equal(evidence.promotionJournal.failures.length, journalRows.length, 'the sidecar carries every failure row');
  for (const row of evidence.promotionJournal.failures) assertSafeFailureRow(row, 'the sidecar');
  assert.deepEqual(
    evidence.promotionJournal.failures.map((row) => row.target),
    journalRows.map((row) => row.target),
    'both boundaries agree on which targets failed',
  );
  assert.match(evidence.failure.errorSummary, /rollback failed|journal preserved/, 'the failure keeps a readable summary');
  assert.match(evidence.failure.errorDigest, /^sha256:[0-9a-f]{16}$/);
});

test('a rollback failure without a credential keeps the journal readable and diagnosable', async (t) => {
  // Contrast case: the same CAS conflict with a healthy refresh. The journal
  // bytes change shape only where the failure rows are projected; the recovery
  // plan, the phase and the preserved directory are untouched.
  const { paths, core, exec, experimentId, archive } = await measuredFixture(t, 'review-cas-projected');
  await fs.writeFile(archive, 'PREPARE BASELINE\n');
  const external = 'EXTERNAL EDIT MUST SURVIVE\n';

  await commitWithExternalEdit(paths, core, exec, experimentId, archive, external);

  const journalFile = path.join(paths.promotionStateDir, 'journal.json');
  assert.equal(await exists(journalFile), true, 'the journal directory is preserved');
  const journal = await readJournal(paths);
  assert.equal(journal.phase, 'rollback-failed');
  assert.equal(journal.stateDir, paths.promotionStateDir);
  assert.ok(journal.records.length > 0, 'the recovery plan is untouched');
  assert.ok(journal.records.every((record) => typeof record.target === 'string'), 'every planned target is still named');
  assert.ok(journal.records.some((record) => typeof record.beforeDigest === 'string'), 'the file digests the rollback compares against are untouched');
  assert.equal(journal.rollbackFailures.length, 1, JSON.stringify(journal.rollbackFailures));
  const [row] = journal.rollbackFailures;
  assertSafeFailureRow(row, 'journal.json');
  assert.equal(row.target, archive);
  assert.match(row.errorSummary, /CAS conflict/, 'the reason is not erased by the projection');
  assert.equal(row.errorSummary.includes('[redacted]'), false, 'a non-credential reason is not rewritten');

  const evidence = JSON.parse(await fs.readFile(path.join(paths.archiveDir, `${experimentId}.failure.json`), 'utf8'));
  assert.deepEqual(evidence.promotionJournal.failures, journal.rollbackFailures, 'both boundaries write the same rows');
  assert.equal(await fs.readFile(archive, 'utf8'), external, 'the external edit is still preserved');
});
