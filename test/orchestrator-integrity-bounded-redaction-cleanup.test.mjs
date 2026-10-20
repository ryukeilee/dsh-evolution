// Review blocker 2 (P1), sixth round — the most severe one.
//
// (a) The redaction rule family threw `RangeError: Maximum call stack size
//     exceeded` on an 8 MiB pathological input (a run of `\x` inside an
//     unterminated quoted parameter). A scrubber that throws is a bug on its own.
// (b) It was fatal because `failureLearning()` ran *before* the `try/finally`
//     that releases the Trial's target lock and drops the experiment record: the
//     throw skipped both, replaced the original error with the RangeError, and
//     left a target the process refused to release — AGENTS.md invariant 3.
//
// The fixes asserted here:
//  * one shared, bounded, non-throwing entry point (`redactCredentialShapes`),
//    so `compactValue`, `safeErrorEvidence`, `safeProofForPersistence` and
//    `safeErrorDto` inherit the same semantics instead of each re-implementing
//    them; above `REDACTION_TEXT_BOUND` the text is withheld unscanned, and any
//    rule failure yields the same marker — never the original text, never a
//    truncation of it;
//  * the failure DTO is built inside the `try` that owns the release, and the
//    release is in the `finally`, so no DTO failure can skip it. That ordering is
//    asserted *behaviourally* in
//    `test/review-fix-redaction-coercion-cleanup.test.mjs` (an error whose string
//    conversion throws, and an injected throw on the cleanup/evidence path, on the
//    real `trial()` / `revert()` / `promote()` paths). It used to be asserted here
//    by matching source text, which proved nothing about control flow: moving the
//    DTO above the outer `try` still matched, and re-wrapping a line could fail it.
//    The text assertion was removed rather than repaired;
//  * the original error keeps propagating with its `errorCode`,
//    `errorCategory`, `errorDigest` and `errorLength`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const HOST_CODE = 'return { name: "review", apply() {} };';
const MiB = 1024 * 1024;
// The audit's payload, exactly: `token: VendorV3 a="` followed by repeated `\x`
// padded to 8,388,608 characters with the quote closed.
const AUDIT_BYTES = 8 * 1024 * 1024;
const AUDIT_MESSAGE = `token: VendorV3 a="${'\\x'.repeat(Math.floor((AUDIT_BYTES - 20) / 2))}"`;
// Material that must not survive, and a marker that must, whatever the strategy.
const AUDIT_MATERIAL = 'VendorV3';
const WITHHELD = /^\[redacted\] \[message withheld: (\d+) characters\]$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

test('the audit payload no longer throws, and the summary is withheld rather than truncated', () => {
  assert.ok(AUDIT_MESSAGE.length >= AUDIT_BYTES - 20, 'the payload is the audit size');

  let dto;
  assert.doesNotThrow(() => { dto = safeErrorDto(Object.assign(new Error(AUDIT_MESSAGE), { code: 'ECONNRESET' }), 'trial'); });

  // Bounded and fail-closed: a marker that carries the length and no byte of the
  // original text.
  assert.match(dto.errorSummary, WITHHELD, `the summary is the withheld marker: ${dto.errorSummary}`);
  const [, withheldLength] = WITHHELD.exec(dto.errorSummary);
  assert.equal(Number(withheldLength), AUDIT_MESSAGE.length, 'the marker reports the original length');
  assert.equal(dto.errorSummary.includes(AUDIT_MATERIAL), false);
  assert.equal(dto.errorSummary.includes('\\x'), false);

  // Still diagnosable: the whole raw message is the identity of the failure.
  assert.equal(dto.errorCode, 'ECONNRESET');
  assert.equal(dto.errorCategory, 'runtime-trial');
  assert.equal(dto.errorLength, AUDIT_MESSAGE.length);
  assert.equal(dto.errorDigest, `sha256:${sha256(AUDIT_MESSAGE).slice(0, 16)}`,
    'the digest is still computed on the raw material, so a withheld summary identifies the same failure');
});

test('the shared boundary is total: 1/4/8 MiB mixed escape, unclosed quote and nested payloads', (t) => {
  const shapes = [
    ['escaped parameter, unclosed quote', (cap) => `token: VendorV3 a="${'\\x'.repeat(Math.floor(cap / 2))}`],
    ['backslash run', (cap) => `{"password":"${'\\'.repeat(cap)}`],
    ['quote run', (cap) => `password=${'"'.repeat(cap)}`],
    ['escaped-embedded JSON', (cap) => `{\\"password\\":\\"${'a'.repeat(cap)}`],
    ['four nested stringify layers', (cap) => {
      let payload = `token: VendorV3 ${'a'.repeat(cap)}`;
      for (let layer = 0; layer < 4; layer += 1) payload = JSON.stringify({ error: payload });
      return payload;
    }],
  ];
  const measured = [];
  for (const n of [1, 4, 8]) {
    for (const [name, build] of shapes) {
      const text = build(n * MiB);
      const started = process.hrtime.bigint();
      let dto;
      let threw = null;
      try { dto = safeErrorDto(new Error(text), 'trial'); } catch (error) { threw = `${error?.name}: ${error?.message}`; }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      measured.push({ bytes: text.length, shape: name, elapsedMs });
      t.diagnostic(`${n} MiB ${name}: ${text.length} chars -> ${elapsedMs.toFixed(2)}ms`);
      assert.equal(threw, null, `${n} MiB ${name} threw ${threw}`);
      assert.match(dto.errorSummary, WITHHELD, `${n} MiB ${name}: the summary is withheld`);
      assert.equal(dto.errorLength, text.length);
      // The bound only has to fail on a regression back to unbounded regex work
      // (measured 0.5-9ms); it is not a benchmark of this machine.
      assert.ok(elapsedMs < 500, `${n} MiB ${name}: took ${elapsedMs.toFixed(1)}ms`);
    }
  }
  assert.equal(measured.length, 15, 'every size x shape combination was measured');
});

test('below the bound the rules still run, and a pathological scanned input cannot leak', () => {
  // The documented bound. It is asserted from the outside on purpose: if the
  // constant moves, this test says so instead of silently testing nothing.
  const bound = 64 * 1024;
  // Just under the bound: the rule family really executes (the value is one
  // redaction marker, not a withheld marker), so the bound is not hiding a
  // broken rule.
  const scanned = `token: VendorV3 foo=bar ${'a'.repeat(bound - 64)}Q9vL7zR2`;
  assert.ok(scanned.length <= bound, `the scanned case is under the bound: ${scanned.length}`);
  const dto = safeErrorDto(new Error(scanned), 'trial');
  assert.equal(dto.errorSummary, 'token: [redacted]', `the rules ran: ${dto.errorSummary}`);
  assert.equal(dto.errorSummary.includes('Q9vL7zR2'), false, 'material at the end of a scanned value is redacted too');
  // Over the bound the same shape is withheld instead of scanned.
  const withheldInput = `token: VendorV3 foo=bar ${'a'.repeat(bound)}Q9vL7zR2`;
  const withheld = safeErrorDto(new Error(withheldInput), 'trial');
  assert.match(withheld.errorSummary, WITHHELD, 'over the bound the text is withheld, not scanned');
  assert.equal(withheld.errorSummary.includes('Q9vL7zR2'), false);
  assert.equal(withheld.errorLength, withheldInput.length);
});

async function scratch(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-integrity-bounded-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function markdownFiles(root) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) found.push(full);
    }
  };
  await walk(root);
  return found;
}

test('a failed Trial with the audit payload releases the target lock, drops the record and persists nothing', async (t) => {
  const root = await scratch(t, 'audit');
  const ctx = context();
  let installed = false;
  const cordisRunner = {
    snapshot: () => (installed ? [{ pluginId: 'reviewed-plugin', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'reviewed-plugin', packageId: 'reviewed-package' }; },
    run: async () => { throw Object.assign(new Error(AUDIT_MESSAGE), { code: 'ECONNRESET' }); },
    stop: async () => { installed = false; return { ok: true }; },
    undefine: async () => { installed = false; return { ok: true }; },
  };
  ctx.dynamicCordisRunner = cordisRunner;
  const core = new EvolutionOrchestrator(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };
  const proposal = core.propose({ why: 'bounded-redaction', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  const target = core.experiments.get(proposal.experimentId).targets[0];
  const ownershipDir = path.join(root, '.evolution-ownership');

  let caught = null;
  try {
    await core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the failing Trial still rejects');
  // The caller receives the original error, not a redaction failure: same
  // identity, same name, same 8 MiB message, and the code survives.
  assert.notEqual(caught.name, 'RangeError', `the scrubber must not throw into the caller: ${caught.name}: ${caught.message.slice(0, 80)}`);
  assert.equal(caught.message, AUDIT_MESSAGE, 'the caller still receives the original message');
  assert.equal(caught.code, 'ECONNRESET');
  assert.equal(caught.message.length, AUDIT_MESSAGE.length);

  // Invariant 3: a failed define/run releases the target lock and drops the
  // record even though the failure DTO had to be withheld.
  assert.equal(core.experiments.has(proposal.experimentId), false, 'the failed experiment record was dropped');
  assert.equal(core.targetOwners.get(target), undefined, 'the in-memory target lock was released');
  assert.deepEqual(await fs.readdir(ownershipDir).catch(() => []), [], 'the ownership file was removed from disk');

  // The same target can be acquired again in this process.
  cordisRunner.run = async () => ({ ok: true, status: 'active' });
  const again = core.propose({ why: 'retry', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  const retried = await core.trial({ experimentId: again.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec);
  assert.equal(retried.phase, 'trial', 'a new Trial on the same target succeeds');
  assert.equal(core.targetOwners.get(target), again.experimentId);
  await core.revert({ experimentId: again.experimentId }, exec);

  // Durable writes: no plaintext material and no raw message in any of them.
  const archiveFiles = await markdownFiles(root);
  assert.equal(archiveFiles.length, 2, 'the failed Trial and the reverted one are both archived');
  const bodies = {
    archive: (await Promise.all(archiveFiles.map(readText))).join('\n'),
    bridge: await readText(path.join(root, 'events.jsonl')),
    memory: await readText(path.join(root, 'memory.json')),
    inspect: JSON.stringify(core.inspect(exec.agent)),
    drift: await readText(path.join(root, 'drift.json')),
  };
  for (const [where, body] of Object.entries(bodies)) {
    assert.equal(body.includes(AUDIT_MATERIAL), false, `${where} persisted the credential material`);
    assert.equal(body.includes('\\x\\x\\x\\x\\x'), false, `${where} persisted a run of the raw payload`);
    assert.equal(body.includes(`a="${AUDIT_MESSAGE.slice(-8)}`), false, `${where} persisted an unredacted value`);
  }
  // ... and the failure is still diagnosable after being withheld.
  assert.match(bodies.archive, /"errorSummary": "\[redacted\] \[message withheld: \d+ characters\]"/,
    'the archive records the withheld summary with its original length');
  assert.match(bodies.archive, /"errorCode": "ECONNRESET"/, 'the archive keeps the error code');
  assert.match(bodies.archive, /"errorCategory": "runtime-trial"/, 'the archive keeps the classification');
  assert.match(bodies.archive, new RegExp(`"errorDigest": "sha256:${sha256(AUDIT_MESSAGE).slice(0, 16)}"`),
    'the archive keeps the digest of the raw message');
  assert.match(bodies.archive, new RegExp(`"errorLength": ${AUDIT_MESSAGE.length}`), 'the archive keeps the original length');
  const failureEvent = bodies.bridge.trim().split('\n')
    .map((line) => JSON.parse(line))
    .map((envelope) => envelope.event || envelope)
    .find((event) => event?.eventType === 'failure-learned');
  assert.ok(failureEvent, 'failure-learned is emitted');
  assert.equal(failureEvent.failure?.errorCode, 'ECONNRESET');
  assert.match(failureEvent.failure?.errorSummary ?? '', WITHHELD);
  assert.deepEqual(failureEvent.failure?.rollbackResult, { ok: true }, 'the rollback receipt still reaches the record');
});

test('a failed Trial whose evidence writes all fail still releases the lock and rethrows the original error', async (t) => {
  const root = await scratch(t, 'dto-throw');
  const ctx = context();
  ctx.dynamicCordisRunner = {
    snapshot: () => [],
    define: () => ({ pluginId: 'reviewed-plugin', packageId: 'reviewed-package' }),
    run: async () => { throw new Error('synthetic trial failure'); },
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
  const warnings = [];
  ctx.logger = { warn: (message) => warnings.push(message), debug: () => {}, info: () => {} };
  const core = new EvolutionOrchestrator(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };
  const proposal = core.propose({ why: 'dto-throw', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  const target = core.experiments.get(proposal.experimentId).targets[0];

  // Simulate the case where every evidence path fails: the archive is unwritable
  // at the same time as the Trial fails, so the cleanup has to run with no
  // durable record at all.
  const archiveDir = path.join(root, 'knowledge', 'archive');
  await fs.mkdir(path.dirname(archiveDir), { recursive: true });
  await fs.writeFile(archiveDir, 'not a directory\n');
  const originalError = new Error('synthetic trial failure');
  ctx.dynamicCordisRunner.run = async () => { throw originalError; };

  await assert.rejects(core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
    (error) => error === originalError, 'the caller receives the original error object, unchanged');

  assert.equal(core.experiments.has(proposal.experimentId), false, 'the record was dropped');
  assert.equal(core.targetOwners.get(target), undefined, 'the target lock was released');
  assert.deepEqual(await fs.readdir(path.join(root, '.evolution-ownership')).catch(() => []), [],
    'the ownership file was removed even though every evidence write failed');
  assert.ok(warnings.some((warning) => /trial evidence write failed|trial-failed archive failed/.test(warning)),
    `the evidence failure is reported as a warning: ${JSON.stringify(warnings)}`);

  // The target is immediately reusable.
  ctx.dynamicCordisRunner.run = async () => ({ ok: true, status: 'active' });
  const again = core.propose({ why: 'retry', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  const retried = await core.trial({ experimentId: again.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec);
  assert.equal(retried.phase, 'trial');
});
