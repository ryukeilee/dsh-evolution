// Review blocker 1 (P1): credentials that arrive as JSON, or with a quoted key
// and/or a quoted value, survived `redactCredentialShapes`. The assignment rule
// required `key[:=]` immediately followed by a bare, whitespace-delimited value,
// so `{"password":"review-secret"}` matched nothing at all.
//
// This file pins the audit's original payload plus the shapes around it and
// proves that the archive, the event bridge, the failure memory and
// `evolution_runtime_inspect` all stay free of the plaintext, while the failure
// still carries a usable classification and an irreversible digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const SECRETS = [
  'review-secret',
  'review-key-value',
  'review-quoted-value',
  'review-single-quoted',
  'review-nested-secret',
  'review-container-secret',
];

// The audit payload first, then one line per additionally covered shape.
const RAW_MESSAGE = [
  'request failed: {"password":"review-secret","api_key":"review-key-value"}',
  'quoted: password: "review-quoted-value"',
  "single: 'token':'review-single-quoted'",
  'nested: "{\\"secret\\":\\"review-nested-secret\\"}"',
  'container: {"credentials":{"value":"review-container-secret"}}',
].join(' | ');

const HOST_CODE = 'return { name: "review", apply() {} };';

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-review-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runner() {
  return {
    snapshot: () => [],
    define: () => ({ pluginId: 'evolved-plugin', packageId: 'evolved-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
}

function isolated(ctx, root) {
  return new EvolutionOrchestrator(ctx, {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
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

function assertNoPlaintext(where, body) {
  for (const secret of SECRETS) {
    assert.equal(body.includes(secret), false, `${where} must not persist the raw credential shape ${secret}`);
  }
}

test('a JSON/quoted credential shape is redacted by the one rule the whole boundary shares', () => {
  for (const secret of SECRETS) {
    const dto = safeErrorDto(new Error(RAW_MESSAGE), 'trial');
    assert.equal(JSON.stringify(dto).includes(secret), false, `safeErrorDto leaked ${secret}`);
  }
  const summary = safeErrorDto(new Error(RAW_MESSAGE), 'trial').errorSummary;
  assert.equal(summary.includes('[redacted]'), true, `the summary still marks the redaction: ${summary}`);
  // Redaction must not erase the information the record exists for: the digest
  // and the length are computed on the raw text, and the category survives.
  const dto = safeErrorDto(new Error(RAW_MESSAGE), 'trial');
  assert.equal(dto.errorCategory, 'runtime-trial');
  assert.match(dto.errorDigest, /^sha256:[0-9a-f]{16}$/);
  assert.equal(dto.errorLength, RAW_MESSAGE.length, 'the length describes the raw message, not the redacted one');
  assert.equal(safeErrorDto(new Error(RAW_MESSAGE), 'trial').errorDigest, dto.errorDigest, 'the same message keeps one identity');
});

test('every quoted and JSON assignment shape is covered, and non-credentials are left alone', () => {
  const cases = [
    ['{"password":"review-secret"}', ['review-secret']],
    ['{"api_key": "review-key-value"}', ['review-key-value']],
    ['password: "review-quoted-value"', ['review-quoted-value']],
    ["'token':'review-single-quoted'", ['review-single-quoted']],
    ['"{\\"secret\\":\\"review-nested-secret\\"}"', ['review-nested-secret']],
    ['{"credentials":{"value":"review-container-secret"}}', ['review-container-secret']],
    ['"api_keys":["review-secret"]', ['review-secret']],
    // shapes the previous rule already covered, kept as a non-regression net
    ['password=hunter2', ['hunter2']],
    ['admin_token=review-secret', ['review-secret']],
    ['{"db_password":"review-secret"}', ['review-secret']],
    ['postgres://admin:s3cr3tP4ss@db.internal/app', ['s3cr3tP4ss']],
  ];
  for (const [text, secrets] of cases) {
    const summary = safeErrorDto(new Error(text), 'trial').errorSummary;
    for (const secret of secrets) {
      assert.equal(summary.includes(secret), false, `${text} -> ${summary}`);
    }
  }
  // Over-redaction is not the goal: an unrelated JSON document and a word that
  // merely contains a key name must survive.
  for (const text of ['{"name":"review","state":"ok"}', 'mytoken=x', 'the tokenizer ran']) {
    const summary = safeErrorDto(new Error(text), 'trial').errorSummary;
    assert.equal(summary, text, `no credential shape is present: ${summary}`);
  }
});

test('a failed Trial keeps the quoted credential shapes out of the archive, the bridge, the memory and inspect', async (t) => {
  const root = await scratch(t);
  const ctx = context();
  ctx.dynamicCordisRunner = runner();
  const core = isolated(ctx, root);
  const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };

  const proposal = core.propose({ why: 'review-redaction', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  core.runner.run = async () => { throw new Error(RAW_MESSAGE); };
  await assert.rejects(
    core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
    (error) => error.message === RAW_MESSAGE,
    'the caller still receives the real error; only persistence is bounded',
  );

  const [archiveFile] = await markdownFiles(root);
  assert.ok(archiveFile, 'the failed trial is archived');
  const archive = await readText(archiveFile);
  assertNoPlaintext('the archive', archive);
  assert.match(archive, /"errorCategory": "runtime-trial"/, 'the archive keeps a usable failure classification');
  assert.match(archive, /"errorDigest": "sha256:[0-9a-f]{16}"/, 'the archive keeps an irreversible identity');

  const bridge = await readText(path.join(root, 'events.jsonl'));
  assertNoPlaintext('the event bridge', bridge);
  const failureEvent = bridge.trim().split('\n')
    .map((line) => JSON.parse(line))
    .map((envelope) => envelope.event || envelope)
    .find((event) => event?.eventType === 'failure-learned');
  assert.ok(failureEvent, 'failure-learned is emitted');
  assert.equal(failureEvent.failure?.errorCategory, 'runtime-trial');
  assert.equal(typeof failureEvent.failure?.errorDigest, 'string');

  assertNoPlaintext('the failure memory', await readText(path.join(root, 'memory.json')));
  assertNoPlaintext('evolution_runtime_inspect', JSON.stringify(core.inspect(exec.agent)));

  const record = core.experiments.get(proposal.experimentId);
  const failure = record ? JSON.stringify(record.failure) : 'the failed trial record was released';
  assertNoPlaintext('the in-memory failure record', failure);
});

// Review blocker 2 (P1): the assignment rule consumed only the scheme word of an
// HTTP authorization header and left the credential it introduces in plaintext -
// `Authorization: Basic review-secret` persisted as `Authorization: [redacted]
// review-secret`, with the real token still readable in the archive. The header
// rule now runs before the assignment rule and consumes the scheme together with
// the value that follows it.
//
// The plaintexts below carry no vendor prefix, so only the header rule can redact
// them: a token the `sk-` prefix rule would catch anyway proves nothing here.
const AUTHORIZATION_MESSAGES = [
  'Authorization: Bearer abcdefghijklmnop1234',
  'authorization: Basic dXNlcjpwYXNz',
  'proxy-authorization: Digest abcdef123456',
];
const AUTHORIZATION_PLAINTEXT = ['abcdefghijklmnop1234', 'dXNlcjpwYXNz', 'abcdef123456'];

function assertNoAuthorizationPlaintext(where, body) {
  for (const plaintext of AUTHORIZATION_PLAINTEXT) {
    assert.equal(body.includes(plaintext), false,
      `${where} must not persist the credential an authorization header introduces (${plaintext})`);
  }
}

/**
 * Run one failing Trial for real - proposal, isolated runtime, throwing runner -
 * and return every surface it persists to, so the assertions below describe what
 * lands on disk rather than what a DTO builder returns in isolation.
 */
async function failedTrialSurfaces(t, message) {
  const root = await scratch(t);
  const ctx = context();
  ctx.dynamicCordisRunner = runner();
  const core = isolated(ctx, root);
  const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };
  const proposal = core.propose({ why: 'review-authorization-redaction', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
  core.runner.run = async () => { throw new Error(message); };
  await assert.rejects(
    core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
    (error) => error.message === message,
    'the caller still receives the real error; only persistence is bounded',
  );
  const [archiveFile] = await markdownFiles(root);
  assert.ok(archiveFile, 'the failed trial is archived');
  return {
    archive: await readText(archiveFile),
    'event bridge': await readText(path.join(root, 'events.jsonl')),
    'failure memory': await readText(path.join(root, 'memory.json')),
    'evolution_runtime_inspect': JSON.stringify(core.inspect(exec.agent)),
  };
}

test('an authorization header redacts the credential it introduces, not only its scheme', () => {
  const cases = [
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['proxy-authorization: Digest abcdef123456', 'abcdef123456'],
    // A vendor-prefixed token is covered by the header rule as well; the header
    // stays recognisable, so a reader still learns a credential was present.
    ['Authorization: Bearer sk-abcdefghijklmnop1234', 'sk-abcdefghijklmnop1234'],
  ];
  for (const [text, plaintext] of cases) {
    const summary = safeErrorDto(new Error(text), 'trial').errorSummary;
    assert.equal(summary.includes(plaintext), false, `${text} -> ${summary}`);
    assert.equal(summary, `${text.slice(0, text.indexOf(':') + 1)} [redacted]`, `${text} -> ${summary}`);
  }
});

test('a failed Trial keeps authorization-header credentials out of the archive, the bridge, the memory and inspect', async (t) => {
  for (const message of AUTHORIZATION_MESSAGES) {
    const surfaces = await failedTrialSurfaces(t, message);
    for (const [where, body] of Object.entries(surfaces)) assertNoAuthorizationPlaintext(`the ${where}`, body);
    assert.match(surfaces.archive, /authorization: \[redacted\]/i,
      `the archive still names the header it redacted: ${message}`);
  }
});

test('a scheme or key word in ordinary prose is not a credential and is left verbatim', () => {
  for (const text of ['a basic explanation follows', 'the tokenizer ran', 'passwordless login enabled']) {
    const summary = safeErrorDto(new Error(text), 'trial').errorSummary;
    assert.equal(summary, text,
      'the header rule is anchored to the header name, not to a word it can contain');
  }
});
