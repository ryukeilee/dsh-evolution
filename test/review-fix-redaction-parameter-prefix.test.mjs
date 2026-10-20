// Review blocker 1 (P1), sixth round.
//
// The scheme rule used to accept *any* word as an auth scheme and prefer its
// parameter-list branch. For an unrecognised scheme that meant the scheme word
// plus the first `name=value` pair was replaced with `[redacted]` while the rest
// of the value stayed behind, and the conservative bare-value rule that follows
// deliberately refuses to re-match a value that already reads `[redacted]` — so
// the remainder was persisted in plaintext:
//
//   token: X-Custom-Scheme foo=bar <material>        -> token: [redacted] <material>
//   Authorization: VendorV3 realm=x; nonce="<mat>"   -> Authorization: [redacted] nonce="<mat>"
//
// The sixth round restricted the parameter-list branch to a scheme whose grammar
// is known (`AUTH_SCHEME`) and let any other vendor word fall through to the
// bare-value branch. The ninth round removed that layer altogether: there is now
// one whole-value rule for every scheme name, known or unknown, so this file's
// cases and the recognised-scheme cases in
// review-fix-redaction-scheme-key-anchored.test.mjs are the same boundary.
//
// This file asserts the shape the audit reported on three separators (space,
// comma, semicolon), on the rule itself and on the real durable writes of a
// failed Trial: archive, event bridge, failure memory and inspect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const HOST_CODE = 'return { name: "review", apply() {} };';
// Distinctive enough that a four-character fragment is already a leak, short
// enough that the 240-character summary bound never truncates a case.
const SECRET = 'Q9vL7zR2';
const FRAGMENT = SECRET.slice(0, 4);

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

// `<unknown scheme> <parameter-list prefix> <continuation material>`, with the
// three separators the audit asked for. The prefix is a valid `name=value` pair
// on purpose: it is exactly what the old parameter-list branch consumed before
// giving up.
const CASES = [
  ['space', `token: X-Custom-Scheme foo=bar ${SECRET}`],
  ['comma', `token: X-Custom-Scheme foo=bar, ${SECRET}`],
  ['semicolon', `token: X-Custom-Scheme foo=bar; ${SECRET}`],
  ['space, authorization header', `Authorization: VendorV3 realm=example ${SECRET}`],
  ['comma, authorization header', `Authorization: VendorV3 realm=example, ${SECRET}`],
  ['semicolon, authorization header', `Authorization: VendorV3 realm=example; nonce="${SECRET}"`],
];

test('an unrecognised scheme never keeps the material past its first parameter', () => {
  for (const [name, text] of CASES) {
    const summary = summaryOf(text);
    assert.equal(summary.includes(SECRET), false, `${name}: the material is still there: ${summary}`);
    assert.equal(summary.includes(FRAGMENT), false, `${name}: a fragment of the material is still there: ${summary}`);
    // Redaction, not truncation: the key survives and the value is one marker.
    assert.match(summary, /^(?:token|Authorization): \[redacted\]$/, `${name}: the whole value is one redaction: ${summary}`);
  }
});

test('every scheme name takes the same whole-value branch', () => {
  // No scheme grammar any more, so the prose after the value is withheld with it:
  // that is the accepted trade-off, asserted here so it cannot drift silently.
  assert.equal(
    summaryOf(`Authorization: Digest username="alice", nonce="${SECRET}" and the host was unreachable`),
    'Authorization: [redacted]',
  );
  assert.equal(summaryOf(`Authorization: AWS4-HMAC-SHA256 Credential=a/20260101/x, SignedHeaders=b, Signature=${SECRET}`),
    'Authorization: [redacted]');
  // The unrecognised form is unchanged: the value is one unit. Asserted, so the
  // two spellings provably share one rule instead of two branches.
  assert.equal(summaryOf(`Authorization: VendorV3 username="alice", nonce="${SECRET}" and the host was unreachable`),
    'Authorization: [redacted]');
});

test('a failed Trial keeps every parameter-prefix payload out of the archive, the bridge, the memory and inspect', async (t) => {
  for (const [index, [name, text]] of CASES.entries()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-review-prefix-${index}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ctx = context();
    ctx.dynamicCordisRunner = {
      snapshot: () => [],
      define: () => ({ pluginId: 'reviewed-plugin', packageId: 'reviewed-package' }),
      run: async () => { throw new Error(text); },
      stop: async () => ({ ok: true }),
      undefine: async () => ({ ok: true }),
    };
    const core = new EvolutionOrchestrator(ctx, {
      presetDir: root,
      startupDrift: false,
      eventBridgePath: path.join(root, 'events.jsonl'),
      eventBridgeKey: 'k'.repeat(32),
      driftStatePath: path.join(root, 'drift.json'),
      memoryPath: path.join(root, 'memory.json'),
    });
    const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };
    const proposal = core.propose({ why: 'parameter-prefix', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);

    await assert.rejects(
      core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
      (error) => error.message === text,
      `${name}: the caller still receives the real error; only persistence is bounded`,
    );

    const archiveFiles = [];
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.md')) archiveFiles.push(full);
      }
    };
    await walk(root);
    assert.equal(archiveFiles.length, 1, `${name}: the failed trial is archived exactly once`);

    const bodies = {
      archive: await fs.readFile(archiveFiles[0], 'utf8'),
      bridge: await fs.readFile(path.join(root, 'events.jsonl'), 'utf8'),
      memory: await fs.readFile(path.join(root, 'memory.json'), 'utf8'),
      inspect: JSON.stringify(core.inspect(exec.agent)),
    };
    for (const [where, body] of Object.entries(bodies)) {
      assert.equal(body.includes(SECRET), false, `${name}: ${where} persisted the credential material`);
      assert.equal(body.includes(FRAGMENT), false, `${name}: ${where} persisted a fragment of the credential material`);
    }
    // Not vacuous: the durable records were really written, and they still carry
    // the classification, the digest and the redaction marker.
    assert.ok(bodies.memory.length > 0, `${name}: the failure memory was written`);
    assert.match(bodies.memory, /"category": "runtime-trial"/, `${name}: the memory keeps the classification`);
    assert.match(bodies.archive, /"errorCategory": "runtime-trial"/, `${name}: the archive keeps the classification`);
    assert.match(bodies.archive, /"errorDigest": "sha256:[0-9a-f]{16}"/, `${name}: the archive keeps the digest`);
    assert.match(bodies.archive, /\[redacted\]/, `${name}: the archive marks the redaction`);
    const failureEvent = bodies.bridge.trim().split('\n')
      .map((line) => JSON.parse(line))
      .map((envelope) => envelope.event || envelope)
      .find((event) => event?.eventType === 'failure-learned');
    assert.ok(failureEvent, `${name}: failure-learned is emitted`);
    assert.equal(failureEvent.failure?.errorSummary.includes(SECRET), false, `${name}: the event summary is redacted`);
  }
});
