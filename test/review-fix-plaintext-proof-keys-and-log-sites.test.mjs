// Review round 4, two confirmed plaintext leaks that rounds 1-3 left in place.
//
// LEAK 1 - `safeErrorEvidence` never received the key-aware rule.
//
// Round 2 taught `compactValue` that a structured record has already separated a
// key from its value, so no *text* rule can see the pair: the decision has to be
// made on the key alone, derived from the one `CREDENTIAL_KEY` table, and the
// value replaced wholesale. `safeErrorEvidence` is a second structural walker -
// the single boundary for `rollbackResult`, `cleanupProof` and `recoveryProof`,
// all three of which land in `exp-*.md`, the evidence sidecar and the event
// bridge - and it kept only its own drop list and `ERROR_TEXT_KEY`. So every
// structured credential key crossed it untouched:
//
//   { evidence: { access_token: "<secret>" } }   -> plaintext
//   { error: { password: "hunter2" } }           -> plaintext
//   { records: [{ token: "<secret>" }] }         -> plaintext
//   { a: { b: { apiKey: "<secret>" } } }         -> plaintext
//
// while the same secret in *text* form (`password=<secret>`) was already
// redacted. The evidence stayed diagnosable and the credential stayed public.
//
// LEAK 2 - three logger sites interpolated the raw error message.
//
//   registration.js  startup drift check unavailable: ${error?.message || error}
//   registration.js  agent error observer failed:      ${error?.message || error}
//   domain-storage.js event log checkpoint not written: ${error?.message || error}
//
// A log line is one of the boundaries in scope, and these three bypassed the DTO
// every neighbouring call site already used.
//
// Both fixes reuse the existing boundary - `isCredentialKeyName` (one predicate,
// one `CREDENTIAL_KEY` table) and `safeErrorDto` - and change no bound: the
// default `maxDepth 4 / maxItems 8`, `PROOF_EVIDENCE_BOUNDS`, `ERROR_SUMMARY_MAX`
// and the drop list are exactly what they were. The tests below are behavioural.
//
// The residual this file does NOT close, and asserts so that closing it is not
// silent: an *unlabelled* high-entropy value is still not redacted, because that
// needs a whole new rule family (see the same residual in
// review-fix-redaction-structural-keys.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EvolutionEventBridge,
  EvolutionOrchestrator,
  safeErrorDto,
  snapshotEvidenceFromRecord,
} from '../lib/orchestrator.js';
import {
  promotionPaths, orchestratorContext, execFor, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const SECRET = 'Z7r6Secret9Qx4Lm2Vb8Np1';
// A value with no credential label, no vendor prefix and no scheme: the
// documented residual of the text rule. Every log line below is asserted to keep
// it and to lose the labelled one, so neither half can drift unnoticed.
const UNLABELLED = 'Qm4Tv8Xn2Kp7Ld5Ws9Rc3Hz6';
const PROOF_KEYS = ['cleanupProof', 'recoveryProof'];

/** The one production projection of a proof record, at its proof bounds. */
function projectedProof(key, proof) {
  return snapshotEvidenceFromRecord({ [key]: proof })[key];
}

/** The default-bound projection, reached through the failure record's receipt. */
async function revertFixture(t, stop) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'evo-round4-proof-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const ctx = orchestratorContext(warnings);
  ctx.dynamicCordisRunner = {
    snapshot: () => [],
    define: () => ({ pluginId: 'review-plugin', packageId: 'review-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop,
    undefine: async () => ({ ok: true }),
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
  };
  const paths = promotionPaths(root);
  const core = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  const exec = execFor('round4-owner');
  const proposal = core.propose({ why: 'round4', target: 'plugin:round4', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  await core.trial({ experimentId: proposal.experimentId, composition: { name: 'r4', purpose: 'r4', code: { host: HOST_CODE } } }, exec);
  const result = await core.revert({ experimentId: proposal.experimentId }, exec);
  return { core, paths, exec, warnings, experimentId: proposal.experimentId, result };
}

async function readText(file) {
  try { return await fsp.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. LEAK 1: the audit's four shapes, on the proof path.
// ---------------------------------------------------------------------------

test('a structured credential key in a cleanup or recovery proof is replaced wholesale', () => {
  const cases = [
    { name: 'access_token under evidence', proof: { evidence: { access_token: SECRET } }, expected: { evidence: { access_token: '[redacted]' } } },
    { name: 'password under error', proof: { error: { password: 'hunter2' } }, expected: { error: { password: '[redacted]' } } },
    { name: 'token inside an array of records', proof: { records: [{ token: SECRET }] }, expected: { records: [{ token: '[redacted]' }] } },
    { name: 'apiKey nested two objects deep', proof: { a: { b: { apiKey: SECRET } } }, expected: { a: { b: { apiKey: '[redacted]' } } } },
    { name: 'the x-api-key spelling', proof: { headers: { 'x-api-key': SECRET } }, expected: { headers: { 'x-api-key': '[redacted]' } } },
    { name: 'a session key', proof: { checks: [{ session_id: SECRET }] }, expected: { checks: [{ session_id: '[redacted]' }] } },
    { name: 'an authorization header value', proof: { lastRequest: { authorization: `Bearer ${SECRET}` } }, expected: { lastRequest: { authorization: '[redacted]' } } },
  ];
  for (const key of PROOF_KEYS) {
    for (const entry of cases) {
      const projected = projectedProof(key, entry.proof);
      assert.deepEqual(projected, entry.expected, `${key} / ${entry.name}`);
      assert.equal(JSON.stringify(projected).includes(SECRET), false, `${key} / ${entry.name}: no plaintext survives`);
      assert.equal(JSON.stringify(projected).includes('hunter2'), false, `${key} / ${entry.name}: no short value survives`);
    }
  }
  // The text rule and the key rule now agree on the same secret: one marker.
  for (const key of PROOF_KEYS) {
    assert.deepEqual(projectedProof(key, { errorMessage: `password=${SECRET}` }), { errorMessage: 'password=[redacted]' });
  }
});

test('the credential key rule reaches every value type and a container is replaced whole', () => {
  for (const key of PROOF_KEYS) {
    const projected = projectedProof(key, {
      asObject: { credentials: { id: 'public', value: SECRET } },
      asArray: { tokens: [SECRET, 'plain'] },
      asNumber: { token: 1234567890 },
      asBoolean: { password: true },
      asNull: { api_key: null },
      container: { credential: { nested: SECRET } },
    });
    // `credential` / `credentials` are containers of the same family: replacing
    // the container is the fail-closed answer, the same one `compactValue` gives.
    assert.deepEqual(projected, {
      asObject: { credentials: '[redacted]' },
      asArray: { tokens: '[redacted]' },
      asNumber: { token: '[redacted]' },
      asBoolean: { password: '[redacted]' },
      asNull: { api_key: '[redacted]' },
      container: { credential: '[redacted]' },
    }, key);
    assert.equal(JSON.stringify(projected).includes(SECRET), false, `${key}: no plaintext survives`);
  }
});

test('the key rule reaches the proof depth bound and the bound itself is unchanged', () => {
  // `PROOF_EVIDENCE_BOUNDS` walks to depth 8, deeper than the default 4: the key
  // rule has to reach exactly as far as the walk it now belongs to.
  const chain = (depth) => {
    let value = { password: SECRET };
    for (let index = 0; index < depth; index++) value = { [`l${index}`]: value };
    return value;
  };
  for (const key of PROOF_KEYS) {
    const deep = projectedProof(key, chain(5)); // the object holding the key is at depth 5
    assert.equal(JSON.stringify(deep).includes(SECRET), false, `${key}: a credential at depth 5 is redacted`);
    assert.match(JSON.stringify(deep), /\[redacted\]/, `${key}: the marker is visible, not an emptied field`);
    // Past the bound the container is withheld rather than walked, exactly as
    // before: the bound is not this round's subject and is not widened.
    const beyond = projectedProof(key, chain(9));
    assert.equal(JSON.stringify(beyond).includes(SECRET), false, `${key}: past the bound nothing is persisted`);
    assert.match(JSON.stringify(beyond), /\[compacted\]/, `${key}: the pre-existing compaction marker is still the answer`);
  }
});

test('ordinary proof evidence is unchanged, including the ERROR_TEXT_KEY treatment and the drop list', () => {
  const ordinary = {
    message: 'the host was unreachable',
    errors: ['timeout'],
    status: 'failed',
    note: 'ok',
    checks: [{ name: 'startup', ok: false }],
    counts: { drift: 2 },
  };
  for (const key of PROOF_KEYS) {
    // Identity, not merely "no secret": a credential-free proof keeps every byte
    // it kept before this change.
    assert.deepEqual(projectedProof(key, structuredClone(ordinary)), ordinary, `${key}: ordinary evidence is untouched`);
  }
  // `ERROR_TEXT_KEY` still routes a credential-shaped *text* value through the
  // DTO, so a `message` field keeps being summarized the same way.
  for (const key of PROOF_KEYS) {
    assert.deepEqual(projectedProof(key, { message: `api_key=${SECRET}` }), { message: 'api_key=[redacted]' });
  }
  // The drop list this change did not touch.
  for (const key of PROOF_KEYS) {
    assert.deepEqual(projectedProof(key, {
      raw: 'x', fullOutput: 'x', stdout: 'x', stderr: 'x', log: 'x', logs: 'x', transcript: 'x', kept: 'yes',
    }), { kept: 'yes' });
  }
});

// ---------------------------------------------------------------------------
// 2. LEAK 1 end to end: the rollback receipt at its default bounds.
// ---------------------------------------------------------------------------

test('a credential inside the rollback receipt never reaches the record, exp-*.md, the sidecar or the bridge', async (t) => {
  // `disposeTrial` stores what `stop()` returned in `rollbackResult.stop`, which
  // `failureLearning` projects at the default bounds. The proof-bound tests above
  // would not have covered this walk.
  const { core, paths, experimentId, result } = await revertFixture(t, async () => ({ ok: false, access_token: SECRET }));
  assert.equal(result.phase, 'revert-failed', 'the fixture must actually fail the revert');
  const record = core.experiments.get(experimentId);
  assert.deepEqual(record.failure.rollbackResult.stop, { ok: false, access_token: '[redacted]' });
  assert.equal(JSON.stringify(record.failure).includes(SECRET), false, 'the in-memory failure record carries no plaintext');
  assert.equal(JSON.stringify(record.cleanupProof).includes(SECRET), false, 'the cleanup proof carries no plaintext');

  const archive = await readText(path.join(paths.archiveDir, `${experimentId}.md`));
  assert.ok(archive.length > 0, 'exp-*.md was written');
  assert.equal(archive.includes(SECRET), false, 'exp-*.md carries no plaintext');
  const sidecar = await readText(path.join(paths.archiveDir, `${experimentId}.evidence.json`));
  assert.equal(sidecar.includes(SECRET), false, 'the evidence sidecar carries no plaintext');
  assert.equal((await readText(paths.eventBridgePath)).includes(SECRET), false, 'the event bridge carries no plaintext');
});

test('a credential-free rollback receipt is byte-identical to its unprojected form', async (t) => {
  // The preservation half: the key rule is the only thing this round added to
  // `safeErrorEvidence`, so a receipt without a credential key must project to
  // itself, field for field.
  const { core, experimentId, result } = await revertFixture(t, async () => ({ ok: false, status: 'refused' }));
  assert.equal(result.phase, 'revert-failed');
  const record = core.experiments.get(experimentId);
  assert.deepEqual(record.failure.rollbackResult, {
    stop: { ok: false, status: 'refused' },
    removed: { ok: true },
    errors: [],
  });
  // The same holds for the proof boundary itself, on a full-shaped clean proof.
  const clean = {
    status: 'recovered',
    source: 'disposeTrial',
    verificationSource: 'disposeTrial:stop+undefine+signature',
    capturedAt: '2026-01-01T00:00:00.000Z',
    beforeFingerprint: { id: 'sig-a', plugins: ['plugin-a'] },
    afterFingerprint: { id: 'sig-a', plugins: ['plugin-a'] },
    noOrphans: true,
    recoveryPending: false,
    runtimeRecovered: true,
    cleanupProof: { stopOk: true, removedOk: true, signatureRecovered: true, errors: [], at: '2026-01-01T00:00:00.000Z' },
  };
  for (const key of PROOF_KEYS) {
    assert.deepEqual(projectedProof(key, structuredClone(clean)), clean, `${key}: the projection is the identity for a clean proof`);
    // Byte level, so a future change to key or value order is not silent.
    assert.equal(JSON.stringify(projectedProof(key, structuredClone(clean))), JSON.stringify(clean), `${key}: same bytes`);
  }
});

// ---------------------------------------------------------------------------
// 3. LEAK 2: the three logger sites.
// ---------------------------------------------------------------------------

test('the startup drift warning carries the safe DTO, not the raw message (behavioural)', async (t) => {
  // Reached behaviourally: `inspectStartupDrift` imports the engine named by the
  // state file, so an engine module that throws on import is an error whose
  // message reaches `ensureStartupDrift`'s rejection handler unchanged.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'evo-round4-drift-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const engineDir = path.join(root, 'repo');
  await fsp.mkdir(path.join(engineDir, 'scripts', 'shared'), { recursive: true });
  await fsp.writeFile(
    path.join(engineDir, 'scripts', 'shared', 'drift-engine.js'),
    `throw new Error("drift engine exploded: unlabelled ${UNLABELLED} and password=${SECRET}");\n`,
  );
  const driftStatePath = path.join(root, 'drift-state.json');
  await fsp.writeFile(driftStatePath, JSON.stringify({ repoRoot: engineDir, liveRoot: root }));

  const warnings = [];
  const paths = promotionPaths(root);
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: () => {},
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  };
  const { apply } = await import('../lib/registration.js');
  apply(ctx, {
    ...paths,
    driftStatePath,
    memoryPath: path.join(root, 'memory.json'),
    archiveDir: path.join(root, 'archive'),
  });
  // The check is fire-and-forget on the registration path: wait for its warning.
  const deadline = Date.now() + 5000;
  while (warnings.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(warnings.length, 1, 'the drift failure produced exactly one warning');
  const line = warnings[0];
  assert.match(line, /startup drift check unavailable/, 'the log line still says which phase failed');
  assert.equal(line.includes(SECRET), false, 'the labelled secret does not reach the log');
  assert.match(line, /\[redacted\]/, 'the redaction is visible in the log line');
  assert.match(line, /sha256:[0-9a-f]{16}/, 'the digest keeps distinct failures distinguishable');
  // The documented residual, asserted so a future closure is not silent: the
  // unlabelled value *before* the labelled one survives, because the bare-value
  // rule starts at the key and runs to the end of the text.
  assert.equal(line.includes(UNLABELLED), true, 'an unlabelled high-entropy value is still not redacted (documented residual)');
  assert.equal(line.includes('unlabelled'), true, 'the prose before the labelled assignment survives');
});

test('the agent error observer warning carries the safe DTO, not the raw message (behavioural)', async (t) => {
  const warnings = [];
  const listeners = new Map();
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  };
  const { apply } = await import('../lib/registration.js');
  const core = apply(ctx, { startupDrift: false, mode: 'autonomous', memory: {}, eventBridge: {} });
  core.observeAutonomous = async () => {
    throw new Error(`observer failed: unlabelled ${UNLABELLED} and password=${SECRET}`);
  };
  listeners.get('agent/error')({ agent: { id: 'round4-agent' }, error: 'original agent error' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1, 'the observer failure produced exactly one warning');
  const line = warnings[0];
  assert.match(line, /agent error observer failed/, 'the log line still says which phase failed');
  assert.equal(line.includes(SECRET), false, 'the labelled secret does not reach the log');
  assert.match(line, /\[redacted\]/);
  // The pre-existing contract this change had to keep: the credential-free part
  // of the message is still readable (test/observer-event-contract.test.mjs
  // asserts the same for `observer failure`).
  assert.match(line, /observer failed/);
  assert.equal(line.includes(UNLABELLED), true, 'the unlabelled residual is unchanged');
});

test('the event log checkpoint warning carries the safe DTO, not the raw message (behavioural)', async (t) => {
  // Reached behaviourally through `openDomainStorage`'s replay: the checkpoint
  // write is the only step that can fail independently of the replay itself, so
  // the failure is injected at that syscall. `renameSync` is the injection point
  // the other storage regressions use for the same reason.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-round4-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { openDomainStorage } = await import('../lib/domain-storage.js');
  const { eventLogCheckpointPath } = await import('../lib/event-log-checkpoint.js');
  const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  t.after(() => backend.close());
  const warnings = [];
  const ctx = {
    emit() {},
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')), error() {} },
    storage: { backend: { get: () => backend } },
    effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey });
  bridge.emit('trial-completed', { id: 'exp-round4', proposal: { target: 'plugin:round4' } }, { status: 'trial' });

  const plainRename = fs.renameSync;
  let injected = false;
  // The exact file, not a substring: the stage manifest and the commit token are
  // renamed on this path too, and only the checkpoint write may fail here.
  const checkpointFile = path.resolve(eventLogCheckpointPath(root));
  fs.renameSync = (from, to) => {
    if (!injected && path.resolve(String(to)) === checkpointFile) {
      injected = true;
      throw new Error(`checkpoint rename failed: unlabelled ${UNLABELLED} and password=${SECRET}`);
    }
    return plainRename.call(fs, from, to);
  };
  let port;
  try {
    port = await openDomainStorage(ctx, config);
  } finally {
    fs.renameSync = plainRename;
  }
  t.after(() => port.close());

  assert.equal(injected, true, 'the checkpoint write must actually have been attempted');
  assert.equal(warnings.length, 1, 'the lost checkpoint produced exactly one warning');
  const line = warnings[0];
  assert.match(line, /event log checkpoint not written/, 'the log line still says which phase failed');
  assert.equal(line.includes(SECRET), false, 'the labelled secret does not reach the log');
  assert.match(line, /\[redacted\]/);
  assert.equal(line.includes(UNLABELLED), true, 'the unlabelled residual is unchanged');
  // The checkpoint is an optimization: losing it must not have failed the open.
  assert.equal(typeof port.observe, 'function', 'the port still opened');
});

// ---------------------------------------------------------------------------
// 4. The three sites now share the boundary the rest of the file already used.
// ---------------------------------------------------------------------------

test('the same error keeps the same DTO across all three log sites, so the digest identifies it', () => {
  // Not a source-text assertion: the three call sites pass the same phase-shaped
  // error through one function, and the DTO is what makes the log line
  // comparable with the failure memory it describes.
  const error = new Error(`attachment upload failed: api_key=${SECRET}`);
  const detail = safeErrorDto(error, 'event-log-checkpoint');
  assert.equal(error.message.includes(SECRET), true, 'the raw error still carries the secret');
  assert.equal(detail.errorSummary.includes(SECRET), false, 'the DTO does not');
  assert.equal(detail.errorSummary, 'attachment upload failed: api_key=[redacted]');
  assert.match(detail.errorDigest, /^sha256:[0-9a-f]{16}$/);
  assert.equal(detail.errorCategory, 'runtime-trial');
  assert.equal(detail.errorLength, error.message.length, 'the length still describes the raw message');
  // A credential-free error is unchanged by the boundary, which is why the log
  // lines above still read as before.
  const plain = safeErrorDto(new Error('the host was unreachable'), 'startup-drift');
  assert.equal(plain.errorSummary, 'the host was unreachable');
});
