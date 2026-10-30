// Review blocker 3 (P2): the promotion commit correctly refused to overwrite an
// external edit of its own archive and preserved the journal as
// `rollback-failed` — and then `promote()`'s failure path called
// `archiveTerminal()`, which wrote that same `exp-*.md` and destroyed the edit.
// A preserved journal owns its target files, so the terminal failure record goes
// to a sidecar and the archive keeps its bytes (AGENTS.md invariant 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, readJournal, exists,
  HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

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

async function measuredFixture(t, name) {
  const root = await scratchRoot(name);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
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
test('a CAS conflict that preserves the journal leaves the externally edited archive byte-identical', async (t) => {
  const { paths, core, exec, experimentId, archive } = await measuredFixture(t, 'review-cas-preserved');
  const baseline = 'PREPARE BASELINE\n';
  await fs.writeFile(archive, baseline);
  const external = 'EXTERNAL EDIT MUST SURVIVE\n';

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
  assert.match(error.message, /rollback failed/, 'the refusal still reports the preserved journal');
  assert.equal(await fs.readFile(archive, 'utf8'), external, 'the external edit is preserved byte for byte');
  assert.notEqual(await fs.readFile(archive, 'utf8'), baseline, 'the archive was not restored over the edit either');
  assert.equal((await readJournal(paths)).phase, 'rollback-failed', 'the journal stays preserved');

  // The failure is not silently dropped: it moves to an independent sidecar next
  // to the archive it must not touch.
  const evidenceFile = path.join(paths.archiveDir, `${experimentId}.failure.json`);
  assert.equal(await exists(evidenceFile), true, `the failure evidence exists at ${evidenceFile}`);
  const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
  assert.equal(evidence.experimentId, experimentId);
  assert.equal(evidence.preservedArchive, archive);
  assert.equal(evidence.promotionJournal.preserved, true);
  assert.equal(evidence.promotionJournal.phase, 'rollback-failed');
  assert.equal(evidence.promotionJournal.stateDir, paths.promotionStateDir);
  assert.equal(evidence.promotionJournal.failures.length > 0, true, 'the rollback failure is recorded');
  assert.equal(evidence.failure.failurePhase, 'promotion-commit');
  assert.equal(evidence.failure.rollbackResult.ok, false);
  assert.equal(evidence.failure.rollbackResult.status, 'rollback-failed');
  assert.equal(evidence.failure.errorCategory.length > 0, true, 'the failure keeps a classification');
  assert.match(evidence.failure.errorDigest, /^sha256:[0-9a-f]{16}$/, 'the failure keeps an irreversible digest');
  assert.match(evidence.failure.errorSummary, /rollback failed|journal preserved/, 'the failure keeps a readable summary');

  // The same failure is user-visible on the event bridge.
  const bridge = await fs.readFile(paths.eventBridgePath, 'utf8');
  assert.match(bridge, /"eventType":"failure-learned"/);
  assert.equal(core.experiments.get(experimentId).failureEvidencePath, evidenceFile);
});

test('the normal promotion commit still writes its archive and no failure sidecar', async (t) => {
  const { paths, core, exec, experimentId, archive } = await measuredFixture(t, 'review-cas-clean');
  await fs.writeFile(archive, 'STALE CONTENT FROM AN EARLIER RUN\n');

  const durable = await core.promote({ experimentId, confirmation: true }, exec);
  assert.equal(durable.ok, true, 'the clean promotion succeeds');

  const written = await fs.readFile(archive, 'utf8');
  assert.equal(written.includes('STALE CONTENT FROM AN EARLIER RUN'), false, 'the commit still replaces the archive it plans');
  assert.match(written, new RegExp(`^# Evolution experiment ${experimentId}$`, 'm'));
  assert.match(written, /^- state: canary-observing$/m);
  assert.match(written, /^- durable plugin: dsh-evolution-promoted-[0-9a-f]{12}$/m);
  assert.match(written, /^- source sha256: [0-9a-f]{64}$/m);
  assert.match(written, /^- proof: \{"status":"recovered"/m);
  assert.match(written, /^## Runtime recovery$/m);
  assert.match(written, /^## Observation$/m);
  assert.equal(written.endsWith('\n'), true, 'the archive keeps its trailing newline');
  assert.equal(await exists(path.join(paths.archiveDir, `${experimentId}.failure.json`)), false, 'a successful promotion writes no failure sidecar');
  assert.equal(durable.nextSession.archivePath, archive);
});
