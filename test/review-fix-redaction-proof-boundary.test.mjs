// Review blocker 2 (P1): `recoveryProof` / `cleanupProof` and the archive and
// event-bridge warnings bypassed the safe error DTO. `disposeTrial` stored
// `error.message` verbatim in `cleanupProof.errors`, `captureCurrentRecoveryProof`
// embedded that proof in `recoveryProof`, and both were written into the
// archive as raw JSON; `archiveTerminal` / `emitEventSafely` also logged the raw
// message. Everything that persists an error text goes through one boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { EvolutionOrchestrator, renderExperimentArchive, replayExperimentEvidence } from '../lib/orchestrator.js';
import {
  scratchRoot, promotionPaths, orchestratorContext, execFor, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const PROOF_SECRET = 'review-proof-secret';
const LOG_SECRET = 'review-log-secret';
const LEGACY_SECRET = 'review-legacy-secret';

function runner() {
  return {
    snapshot: () => [],
    define: () => ({ pluginId: 'evolved-plugin', packageId: 'evolved-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
  };
}

async function fixture(t, name, { stop } = {}) {
  const root = await scratchRoot(name);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  const cordis = runner();
  if (typeof stop === 'function') cordis.stop = stop;
  ctx.dynamicCordisRunner = cordis;
  const paths = promotionPaths(root);
  const core = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  const exec = execFor('review-owner');
  const proposal = core.propose({ why: 'review-proof', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  await core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec);
  return { root, paths, core, exec, warnings, experimentId: proposal.experimentId };
}

test('a credential-shaped stop() failure stays out of the cleanup proof, the recovery proof, the archive, the bridge and the log', async (t) => {
  const { paths, core, exec, warnings, experimentId } = await fixture(t, 'proof-stop', {
    stop: async () => { throw new Error(`stop refused: password=${PROOF_SECRET}`); },
  });

  const result = await core.revert({ experimentId }, exec);
  assert.equal(result.phase, 'revert-failed');
  const record = core.experiments.get(experimentId);

  // The proof still says what went wrong; it just does not carry the secret.
  const cleanup = JSON.stringify(record.cleanupProof);
  assert.equal(cleanup.includes(PROOF_SECRET), false, `cleanupProof leaked: ${cleanup}`);
  assert.match(cleanup, /stop refused/, 'the cleanup failure stays diagnosable');
  assert.equal(record.cleanupProof.errors.length, 1);
  assert.match(record.cleanupProof.errors[0], /stop: .*stop refused.*\[redacted\]/);
  assert.equal(record.cleanupProof.stopOk, false, 'the receipt still reports the failed stop');
  assert.equal(record.cleanupProof.signatureRecovered, true, 'the measured recovery flag is unchanged');

  const recovery = JSON.stringify(record.recoveryProof);
  assert.equal(recovery.includes(PROOF_SECRET), false, `recoveryProof leaked: ${recovery}`);
  assert.match(recovery, /stop refused/, 'the recovery proof keeps the cleanup detail it embeds');
  assert.equal(record.recoveryProof.cleanupProof.stopOk, false);

  const archive = await fs.readFile(result.archive, 'utf8');
  assert.equal(archive.includes(PROOF_SECRET), false, 'the rendered archive leaked the cleanup message');
  assert.match(archive, /stop refused/, 'the archive keeps the failure reason readable');
  assert.equal((await fs.readFile(paths.eventBridgePath, 'utf8')).includes(PROOF_SECRET), false, 'the event bridge leaked the cleanup message');
  assert.equal(JSON.stringify(core.inspect(exec.agent)).includes(PROOF_SECRET), false, 'inspect leaked the cleanup message');
  assert.equal(warnings.join('\n').includes(PROOF_SECRET), false, 'a warning leaked the cleanup message');
});

test('an archive failure is reported through the safe boundary while keeping its classification', async (t) => {
  const { core, experimentId, warnings } = await fixture(t, 'proof-archive-failure');
  const record = core.experiments.get(experimentId);
  const original = core.archive;
  core.archive = async () => { throw new Error(`backend denied token=${LOG_SECRET}`); };
  let written;
  try {
    written = await core.archiveTerminal(record, 'trial-failed');
  } finally {
    core.archive = original;
  }

  assert.equal(written, null, 'an archive failure is a warning, never a thrown cleanup barrier');
  assert.equal(String(record.archiveWarning).includes(LOG_SECRET), false, `the warning leaked: ${record.archiveWarning}`);
  assert.match(String(record.archiveWarning), /backend denied token=\[redacted\]/, 'the warning keeps a readable summary');
  assert.equal(typeof record.archiveWarningCategory, 'string');
  assert.ok(record.archiveWarningCategory.length > 0, 'the warning keeps a failure category');
  assert.match(record.archiveWarningDigest, /^sha256:[0-9a-f]{16}$/, 'the warning keeps an irreversible digest');
  const logged = warnings.at(-1);
  assert.match(logged, /trial-failed archive failed/, `the warning is still logged: ${logged}`);
  assert.equal(logged.includes(LOG_SECRET), false, `the log line leaked: ${logged}`);
  assert.match(logged, /\[redacted\]/, 'the log line marks the redaction');
});

test('an event-bridge failure is reported through the same boundary', async (t) => {
  const { core, experimentId, warnings } = await fixture(t, 'proof-bridge-failure');
  const record = core.experiments.get(experimentId);
  const original = core.emitExecutionEvent;
  core.emitExecutionEvent = () => { throw new Error(`bridge refused cookie=${LOG_SECRET}`); };
  let written;
  try {
    written = core.emitEventSafely(record, 'failure-learned', {});
  } finally {
    core.emitExecutionEvent = original;
  }
  assert.equal(written, null);
  assert.equal(String(record.eventBridgeWarning).includes(LOG_SECRET), false, `the warning leaked: ${record.eventBridgeWarning}`);
  assert.match(String(record.eventBridgeWarning), /bridge refused cookie=\[redacted\]/);
  assert.equal(warnings.at(-1).includes(LOG_SECRET), false, `the log line leaked: ${warnings.at(-1)}`);
});

test('a proof read back by replay is projected before it is written again', async (t) => {
  const { paths, experimentId } = await fixture(t, 'proof-read-back');
  await fs.mkdir(paths.archiveDir, { recursive: true });
  // An older writer left plaintext inside the persisted proof; re-rendering the
  // archive must not copy it forward (the read-back boundary).
  await fs.writeFile(path.join(paths.archiveDir, `${experimentId}.evidence.json`), `${JSON.stringify({
    version: 1,
    source: 'legacy-writer',
    capturedAt: '2026-01-01T00:00:00.000Z',
    observations: [],
    runtimeRecovered: false,
    cleanupProof: { stopOk: false, removedOk: true, errors: [`stop: refused password=${LEGACY_SECRET}`], at: '2026-01-01T00:00:00.000Z' },
    recoveryProof: {
      status: 'recovered',
      capturedAt: '2026-01-01T00:00:00.000Z',
      cleanupProof: { stopOk: false, errors: [`stop: refused password=${LEGACY_SECRET}`] },
    },
  }, null, 2)}\n`);

  const replayed = await replayExperimentEvidence(paths, experimentId);
  const archive = await fs.readFile(replayed.archivePath, 'utf8');
  assert.equal(archive.includes(LEGACY_SECRET), false, `the re-rendered archive leaked the persisted plaintext: ${archive}`);
  assert.match(archive, /refused/, 'the persisted failure stays readable');
  assert.match(archive, /\[redacted\]/, 'the persisted failure is marked as redacted');
  const sidecar = await fs.readFile(replayed.sidecarPath, 'utf8');
  assert.equal(sidecar.includes(LEGACY_SECRET), false, 'the rewritten sidecar must not carry the plaintext forward either');

  // The shared renderer is the same boundary for every caller.
  const rendered = renderExperimentArchive({
    id: 'exp-render',
    state: 'stable',
    reason: 'stable-commit',
    proposal: { owner: 'o', why: 'w', target: 't', impactScope: [], successMetrics: [], createdAt: '2026-01-01T00:00:00.000Z' },
    pluginId: 'none',
    packageId: 'none',
    observations: [],
    latestMeasurement: {},
    recoveryProof: { status: 'unknown', cleanupProof: { errors: [`stop: refused token=${LEGACY_SECRET}`] } },
    recovered: false,
    failure: null,
    memorySignature: 'sig',
    duplicateCount: 1,
    retention: 200,
  });
  assert.equal(rendered.includes(LEGACY_SECRET), false, 'renderExperimentArchive must project the proof');
  assert.match(rendered, /refused/);
});

test('archive() does not write a proof it read back from a plaintext-bearing durable record', async (t) => {
  const { paths, experimentId } = await fixture(t, 'proof-archive-read-back');
  await fs.mkdir(paths.archiveDir, { recursive: true });
  await fs.writeFile(path.join(paths.archiveDir, `${experimentId}.evidence.json`), `${JSON.stringify({
    version: 1,
    source: 'legacy-writer',
    capturedAt: '2026-01-01T00:00:00.000Z',
    observations: [],
    runtimeRecovered: false,
    recoveryProof: {
      status: 'recovered',
      capturedAt: '2026-01-01T00:00:00.000Z',
      cleanupProof: { stopOk: false, removedOk: true, errors: [`stop: refused token=${LEGACY_SECRET}`] },
    },
  }, null, 2)}\n`);

  // A fresh session holds no in-memory proof, so the durable copy is the only
  // source the terminal render has.
  const ctx = orchestratorContext([]);
  ctx.dynamicCordisRunner = runner();
  const fresh = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(paths.presetDir, 'drift.json'),
    memoryPath: path.join(paths.presetDir, 'memory.json'),
  });
  const record = {
    id: experimentId,
    ownerId: 'review-owner',
    state: 'revert-failed',
    proposal: { owner: 'review-owner', why: 'review-proof', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'], createdAt: '2026-01-01T00:00:00.000Z' },
    targets: [],
    observations: [],
    latestObservation: {},
    runtimeRecovered: false,
  };
  const file = await fresh.archive(record, 'revert');
  const content = await fs.readFile(file, 'utf8');
  assert.equal(content.includes(LEGACY_SECRET), false, `archive() re-emitted the persisted plaintext: ${content}`);
  assert.match(content, /refused/, 'the persisted failure stays readable');
  assert.match(content, /\[redacted\]/, 'the persisted failure is marked as redacted');
});
