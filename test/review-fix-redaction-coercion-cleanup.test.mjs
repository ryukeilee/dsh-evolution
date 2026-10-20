// Review blocker (P1), seventh round — the safe-error boundary was total for
// *text* but not for the object it read:
//
//   const sentinel = new Error('coercion sentinel');
//   const bad = { message: { toString() { throw sentinel; } } };
//
// `safeErrorDto` called `safeString(error?.message ?? error)` *before*
// `redactCredentialShapes`, so the coercion ran outside the guard and the throw
// escaped the DTO constructor. Two independent defects followed:
//
//  (a) the boundary threw at all (`coercionThrows: true`), which the sixth round
//      claimed it never did; and
//  (b) it threw *before* `revert()`'s cleanup completed, so `undefine()` never
//      ran and the operation claim and the target lock both stayed behind
//      (`operationClaims: [[exp, "revert"]]`, `targetOwners: [[plugin, exp]]`,
//      `state: "reverting"`).
//
// Every case below is a **behavioural** injection test: a real failure path is
// driven end to end and the assertions are about what the caller received and
// what the orchestrator still holds — nothing here matches source text, so
// moving a statement, renaming a local or reformatting the file cannot make these
// pass or fail. The ordering proof is the state after the throw:
//
//  * `safeErrorDto` never throws and degrades to a fixed, text-free DTO whose key
//    set is the same five keys as the readable path;
//  * `disposeTrial()` runs `undefine()` even when the `stop()` receipt cannot be
//    built;
//  * `revert()` / `promote()` release the operation claim on every throw, and
//    release the target lock only on a *proven* recovery — `promotion-cleanup`
//    keeps it on purpose (AGENTS.md invariant 3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import {
  promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const COMPOSITION = { name: 'coercion', purpose: 'coercion', code: { host: HOST_CODE } };
const PROPOSAL = { why: 'coercion cleanup', target: 'plugin:coercion', impactScope: ['test'], successMetrics: ['errors'] };
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

// The complete key set of the degraded DTO, asserted field by field: a caller may
// not lose a key just because the error could not be read.
const DEGRADED_DTO = {
  errorCode: null,
  errorCategory: 'unclassified',
  errorDigest: 'sha256:unavailable',
  errorSummary: '[error details unavailable: the error object could not be read]',
  errorLength: 0,
};
const DEGRADED_SUMMARY = DEGRADED_DTO.errorSummary;
const WITHHELD_TEXT = '[error details unavailable';

/** The review's object: reading `message` works, converting it throws. */
function coercionThrowingError(label) {
  const sentinel = new Error(`${label} coercion sentinel`);
  const thrown = { message: { toString() { throw sentinel; } } };
  return { sentinel, thrown };
}

async function harness(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-review-coercion-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  await fs.writeFile(paths.compositionPath, '[]\n');
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  let installed = false;
  const cordisRunner = {
    snapshot: () => (installed ? [{ pluginId: 'review-plugin', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'review-plugin', packageId: 'review-package' }; },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => { installed = false; return { ok: true }; },
    undefine: async () => { installed = false; return { ok: true }; },
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
  };
  ctx.dynamicCordisRunner = cordisRunner;
  const core = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  const exec = execFor('review-owner');
  return { root, paths, core, exec, warnings, cordisRunner };
}

function targetOf(core, experimentId) {
  return core.experiments.get(experimentId).targets[0];
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/** Every durable body the failure could have reached, plus the live inspect view. */
async function durableBodies(h, experimentId) {
  return {
    archive: await readText(path.join(h.paths.archiveDir, `${experimentId}.md`)),
    bridge: await readText(h.paths.eventBridgePath),
    memory: await readText(path.join(h.root, 'memory.json')),
    inspect: JSON.stringify(h.core.inspect(h.exec.agent)),
  };
}

function ownershipDir(h) {
  // `promotionPaths()` does not set `ownershipDir`, so `defaultPaths()` derives it
  // from `presetDir`; read the directory the orchestrator actually uses.
  return h.paths.ownershipDir ?? path.join(h.paths.presetDir, '.evolution-ownership');
}

async function ownershipFiles(h) {
  return fs.readdir(ownershipDir(h)).catch(() => []);
}

test('safeErrorDto is total: no read and no conversion can throw, and the degraded DTO keeps the full key set', () => {
  const { sentinel, thrown } = coercionThrowingError('boundary');
  const cases = {
    'a message whose toString throws': thrown,
    'a message read through a throwing getter': { get message() { throw sentinel; } },
    'a thrower with no message at all': { toString() { throw sentinel; } },
    'a code read through a throwing getter': { message: 'readable', get code() { throw sentinel; } },
    'a message with a throwing Symbol.toPrimitive': { message: { [Symbol.toPrimitive]() { throw sentinel; } } },
    'a throwing name/stack on an otherwise readable error': Object.defineProperty(
      Object.defineProperty({ message: 'readable' }, 'name', { get() { throw sentinel; } }),
      'stack', { get() { throw sentinel; } },
    ),
  };
  for (const [name, value] of Object.entries(cases)) {
    let dto;
    assert.doesNotThrow(() => { dto = safeErrorDto(value, 'cleanup'); }, `${name} must not throw out of the boundary`);
    assert.deepEqual(Object.keys(dto).sort(), Object.keys(DEGRADED_DTO).sort(), `${name}: the DTO keeps the same five keys`);
    if (name.startsWith('a throwing name/stack')) {
    // `name` and `stack` are never read, so a thrower on either cannot reach the
    // boundary at all: the readable message still crosses.
      assert.equal(dto.errorSummary, 'readable', `${name}: the readable message is still reported`);
      continue;
    }
    assert.deepEqual(dto, DEGRADED_DTO, `${name}: an unreadable error degrades to the fixed DTO`);
  }
  // The degraded digest cannot be mistaken for a real one: a readable DTO is
  // `sha256:` plus exactly 16 hex characters.
  assert.match(safeErrorDto(new Error('readable'), 'trial').errorDigest, /^sha256:[0-9a-f]{16}$/);
  assert.doesNotMatch(DEGRADED_DTO.errorDigest, /^sha256:[0-9a-f]{16}$/);
  // A non-string phase is a classification input, not a TypeError.
  assert.equal(safeErrorDto(new Error('x'), { toString: () => 'trial' }).errorCategory, 'runtime-trial');
});

test('trial(): a thrown error whose conversion throws releases the target lock, drops the record and rethrows the original object', async (t) => {
  const h = await harness(t, 'trial-coercion');
  const { sentinel, thrown } = coercionThrowingError('trial');
  h.cordisRunner.run = async () => { throw thrown; };

  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  await assert.rejects(
    h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec),
    (error) => error === thrown,
    'the caller receives the thrown object itself — not the sentinel, not a boundary error',
  );

  assert.equal(h.core.experiments.has(proposal.experimentId), false, 'the failed experiment record was dropped');
  assert.equal(h.core.targetOwners.get(target), undefined, 'the in-memory target lock was released');
  assert.deepEqual(await ownershipFiles(h), [], 'the ownership file was removed from disk');
  assert.equal(h.warnings.some((warning) => warning.includes('coercion sentinel')), false,
    `no warning carries the sentinel: ${JSON.stringify(h.warnings)}`);

  // The degraded DTO is what reached the durable records, with the full key set.
  const bodies = await durableBodies(h, proposal.experimentId);
  assert.ok(bodies.archive.length > 0, 'the failed Trial is still archived');
  for (const [where, body] of Object.entries(bodies)) {
    assert.equal(body.includes('coercion sentinel'), false, `${where}: the sentinel text was persisted`);
    assert.equal(body.includes('toString'), false, `${where}: a fragment of the hostile object was persisted`);
  }
  assert.match(bodies.archive, /"errorCategory": "unclassified"/, 'the archive records the degraded classification');
  assert.match(bodies.archive, /"errorDigest": "sha256:unavailable"/, 'the archive records the placeholder digest');
  assert.match(bodies.archive, new RegExp(`"errorLength": 0`), 'the archive records that no text was measured');
  assert.equal(bodies.archive.includes(DEGRADED_SUMMARY), true, 'the archive records the fixed summary');

  // ... and the target is immediately reusable in the same process.
  h.cordisRunner.run = async () => ({ ok: true, status: 'active' });
  const again = h.core.propose(PROPOSAL, h.exec);
  const retried = await h.core.trial({ experimentId: again.experimentId, composition: COMPOSITION }, h.exec);
  assert.equal(retried.phase, 'trial', 'a new Trial on the same target succeeds');
  assert.equal(h.core.targetOwners.get(target), again.experimentId);
});

test('trial(): a throw from the evidence step still releases the lock and drops the record', async (t) => {
  const h = await harness(t, 'trial-evidence-throw');
  h.cordisRunner.run = async () => { throw new Error('synthetic trial failure'); };
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  const failure = new Error('synthetic evidence throw');
  // Injected throw *inside* the guarded evidence block: with the DTO construction
  // and the archive write both in it, the release in the `finally` must still run.
  h.core.archiveTerminal = async () => { throw failure; };

  await assert.rejects(
    h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec),
    (error) => error?.message === 'synthetic trial failure',
    'the caller still receives the Trial failure, not the evidence failure',
  );
  assert.equal(h.core.experiments.has(proposal.experimentId), false, 'the record was dropped');
  assert.equal(h.core.targetOwners.get(target), undefined, 'the target lock was released');
  assert.deepEqual(await ownershipFiles(h), [], 'the ownership file was removed');
});

test('revert(): a stop() failure whose conversion throws still runs undefine() and releases only the operation claim', async (t) => {
  const h = await harness(t, 'revert-coercion');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);

  const { sentinel, thrown } = coercionThrowingError('stop');
  let undefines = 0;
  h.cordisRunner.stop = async () => { throw thrown; };
  h.cordisRunner.undefine = async () => { undefines += 1; return { ok: true }; };

  const result = await h.core.revert({ experimentId: proposal.experimentId }, h.exec);

  assert.equal(undefines, 1, 'undefine() ran even though the stop() receipt could not be built');
  assert.equal(result.ok, false, 'a cleanup that did not prove recovery is not a revert');
  assert.deepEqual(result.removed, { ok: true }, 'the undefine receipt survived');
  assert.deepEqual(result.stop, {
    ok: false, error: DEGRADED_SUMMARY, errorCategory: DEGRADED_DTO.errorCategory, errorDigest: DEGRADED_DTO.errorDigest,
  }, 'the stop receipt is the fixed, text-free one');
  assert.equal(h.core.operationClaims.has(proposal.experimentId), false, 'the operation claim was released');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(record.state, 'revert-failed');
  assert.equal(record.runtimeRecovered, false);
  assert.equal(record.cleanupProof.errors.length, 1);
  assert.match(record.cleanupProof.errors[0], new RegExp(`^stop: `));
  // An unproven recovery keeps the target lock: the runtime may still own it.
  assert.equal(h.core.targetOwners.get(target), proposal.experimentId, 'the target lock was deliberately retained');
  assert.equal((await ownershipFiles(h)).length, 1, 'the ownership file is still on disk');

  const bodies = await durableBodies(h, proposal.experimentId);
  for (const [where, body] of Object.entries(bodies)) {
    assert.equal(body.includes('coercion sentinel'), false, `${where}: the sentinel text was persisted`);
  }
  assert.match(bodies.archive, /"errorCategory": "unclassified"/, 'the archive records the degraded classification');
});

test('revert(): a throw from the cleanup path itself still releases the operation claim and keeps the target lock', async (t) => {
  const h = await harness(t, 'revert-dispose-throw');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);

  // The boundary is total by construction now, so the only way to exercise the
  // caller's enclosure is to make the cleanup step itself throw. This is exactly
  // the shape the review reproduced, minus the DTO: `await disposeTrial()` used to
  // sit *before* the `try` whose `finally` releases the claim.
  const boom = new Error('synthetic dispose throw');
  h.core.disposeTrial = async () => { throw boom; };

  await assert.rejects(
    h.core.revert({ experimentId: proposal.experimentId }, h.exec),
    (error) => error === boom,
    'the cleanup error still reaches the caller unchanged',
  );
  assert.equal(h.core.operationClaims.has(proposal.experimentId), false, 'the operation claim was released by the finally');
  assert.equal(h.core.targetOwners.get(target), proposal.experimentId,
    'an unknown cleanup outcome may not release the target lock');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(record.state, 'revert-failed', 'the record does not stay in "reverting"');
  assert.equal(record.failure.failurePhase, 'revert', 'the failure is still recorded');
  assert.equal(record.failure.errorSummary, 'synthetic dispose throw');
});

test('promote(): an inspection error whose conversion throws releases the claim and the lock, and the target becomes reusable', async (t) => {
  const h = await harness(t, 'promote-inspection-coercion');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  h.core.measure({ experimentId: proposal.experimentId, observation: OBSERVATION }, h.exec);

  const { sentinel, thrown } = coercionThrowingError('inspect');
  h.cordisRunner.inspectPackage = () => { throw thrown; };

  const result = await h.core.promote({ experimentId: proposal.experimentId, confirmation: true }, h.exec);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'package-inspection-failed');
  assert.equal(result.runtimeRecovered, true, 'the cleanup itself proved recovery');
  assert.equal(h.core.operationClaims.has(proposal.experimentId), false, 'the operation claim was released');
  assert.equal(h.core.targetOwners.get(target), undefined, 'a proven recovery releases the target lock');
  assert.deepEqual(await ownershipFiles(h), [], 'the ownership file was removed');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(record.failure.failurePhase, 'promotion-inspection');
  assert.equal(record.failure.errorSummary, DEGRADED_SUMMARY, 'the failure carries the fixed, text-free summary');
  assert.equal(record.failure.errorCategory, 'unclassified');
  assert.equal(record.failure.errorLength, 0);
  const bodies = await durableBodies(h, proposal.experimentId);
  for (const [where, body] of Object.entries(bodies)) {
    assert.equal(body.includes('coercion sentinel'), false, `${where}: the sentinel text was persisted`);
  }
});

test('promote(): a throw from the cleanup path itself releases the operation claim and keeps the target lock', async (t) => {
  const h = await harness(t, 'promote-dispose-throw');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  h.core.measure({ experimentId: proposal.experimentId, observation: OBSERVATION }, h.exec);

  const boom = new Error('synthetic dispose throw');
  h.core.disposeTrial = async () => { throw boom; };

  await assert.rejects(
    h.core.promote({ experimentId: proposal.experimentId, confirmation: true }, h.exec),
    (error) => error === boom,
    'the cleanup error still reaches the caller unchanged',
  );
  assert.equal(h.core.operationClaims.has(proposal.experimentId), false, 'the operation claim was released');
  assert.equal(h.core.targetOwners.get(target), proposal.experimentId,
    'an unknown cleanup outcome may not release the target lock');
  assert.equal((await ownershipFiles(h)).length, 1, 'the ownership file is still on disk');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(record.state, 'revert-failed');
  assert.equal(record.failure.failurePhase, 'promotion-cleanup');
});

test('promote(): the promotion-cleanup branch keeps the target lock on purpose and releases only the claim', async (t) => {
  const h = await harness(t, 'promotion-cleanup-lock');
  const proposal = h.core.propose(PROPOSAL, h.exec);
  const target = targetOf(h.core, proposal.experimentId);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  h.core.measure({ experimentId: proposal.experimentId, observation: OBSERVATION }, h.exec);
  // The runtime was not recovered: the disposer refuses, so no recovery is proven.
  h.cordisRunner.stop = async () => ({ ok: false, error: 'disposer refused' });

  const result = await h.core.promote({ experimentId: proposal.experimentId, confirmation: true }, h.exec);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-not-recovered');
  assert.equal(result.gates.runtimeRecovered, false, 'the gate records that the runtime was not recovered');
  assert.equal(h.core.operationClaims.has(proposal.experimentId), false, 'the operation claim was released');
  assert.equal(h.core.targetOwners.get(target), proposal.experimentId,
    'AGENTS.md invariant 3: an unrecovered runtime keeps its target lock');
  assert.equal((await ownershipFiles(h)).length, 1, 'the ownership file is still on disk');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(record.state, 'revert-failed');
  assert.equal(record.targetsAcquired, true);
  assert.equal(record.failure.failurePhase, 'promotion-cleanup');
  assert.equal(record.failure.rollbackResult.stop.ok, false);
});

test('the documented 64 KiB bound is the measured behaviour, including what it loses', () => {
  // The comment on `REDACTION_TEXT_BOUND` used to claim the bound cost no durable
  // information. It does: at 65,536 characters the summary still keeps its first
  // `ERROR_SUMMARY_MAX` characters (as `compactValue()` keeps its first
  // `maxText`), and from 65,537 characters the field is the withheld marker, so
  // those characters are gone. Both sides are asserted, so neither the comment
  // nor the constant can drift silently.
  const atBound = safeErrorDto(new Error('a'.repeat(65536)), 'trial');
  assert.equal(atBound.errorSummary.length, 240, '65,536 characters still keep a 240-character prefix');
  assert.equal(atBound.errorSummary, 'a'.repeat(240), 'the kept prefix is the head of the redacted text');
  const overBound = safeErrorDto(new Error('a'.repeat(65537)), 'trial');
  assert.equal(overBound.errorSummary, '[redacted] [message withheld: 65537 characters]',
    '65,537 characters lose that prefix and become the withheld marker');
  assert.equal(overBound.errorLength, 65537, 'the length is still reported');
});

test('the 4 KiB classification bound is a precision loss, not a semantic no-op', () => {
  // `ERROR_CATEGORY_TEXT_BOUND` only reads the first 4 KiB, so a keyword that
  // appears later cannot change the category. Measured here so the comment's
  // "precision loss" wording stays tied to the behaviour.
  assert.equal(safeErrorDto(new Error('regression at the start'), 'trial').errorCategory, 'regression');
  assert.equal(safeErrorDto(new Error(`${'y'.repeat(4200)} regression`), 'trial').errorCategory, 'runtime-trial',
    'the same keyword after the bound no longer changes the classification');
});
