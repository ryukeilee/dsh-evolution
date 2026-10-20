// Review blockers A and B (P1), third round. The authorization-header rule was
// anchored to the header names `authorization` / `proxy-authorization` and only
// accepted `:`, so every other credential key with either separator reached the
// generic assignment rule, which consumed the scheme word and left the material
// it introduces in plaintext:
//
//   Authorization=Basic <token>    -> Authorization=[redacted] <token>
//   X-Auth-Token: Bearer <token>   -> X-Auth-Token: [redacted] <token>
//   token: Basic <token>           -> token: [redacted] <token>
//
// and, because the rule accepted only one opaque token, a Digest parameter list
// was cut at the first parameter:
//
//   Authorization: Digest username="alice", realm="test",
//     nonce="<token>", response="<token>"
//   -> Authorization: [redacted]"alice", realm="test", nonce="<token>", ...
//
// The rule is no longer a list of header names: it is anchored on the same
// `CREDENTIAL_KEY` table as the assignment rule, accepts `:` or `=` with any
// spacing, and consumes the scheme *and* the material it introduces, before the
// assignment rule can see it. `Digest`, `AWS4-HMAC-SHA256` and `Signature` carry
// a parameter list, which is consumed up to the last `name=value` pair.
//
// The matrix test below is the systematic requirement: it does not enumerate the
// audit's shapes, it enumerates the axes (key x separator x scheme x value form)
// and asserts that no combination keeps a fragment of the secret. The residuals
// this rule does *not* cover are listed at its definition in lib/orchestrator.js
// and repeated in the last test here, so the claim stays falsifiable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST_CODE = 'return { name: "review", apply() {} };';
// Short enough that the 240-character summary bound never truncates a test case:
// a leak hidden past the bound would not be asserted on.
const SECRET = 'r3pfx7k2m';

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

// The audit's seven failing shapes plus the two parameter-list forms.
const AUDIT_SHAPES = [
  { text: `Authorization=Basic ${SECRET}`, summary: 'Authorization=[redacted]' },
  { text: `Authorization=Bearer ${SECRET}`, summary: 'Authorization=[redacted]' },
  { text: `X-Auth-Token: Bearer ${SECRET}`, summary: 'X-Auth-Token: [redacted]' },
  { text: `token: Bearer ${SECRET}`, summary: 'token: [redacted]' },
  { text: `token: Basic ${SECRET}`, summary: 'token: [redacted]' },
  { text: `X-Auth-Token: Basic ${SECRET}`, summary: 'X-Auth-Token: [redacted]' },
  {
    text: `Authorization: Digest username="alice", realm="test",\n  nonce="${SECRET}", response="${SECRET}"`,
    summary: 'Authorization: [redacted]',
  },
  {
    text: `Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${SECRET}`,
    summary: 'Authorization: [redacted]',
  },
  { text: `Authorization: Signature keyId="k1", algorithm="rsa-sha256", signature="${SECRET}"`, summary: 'Authorization: [redacted]' },
];

const KEYS = ['Authorization', 'Proxy-Authorization', 'X-Auth-Token', 'X-Api-Key', 'token', 'access_token', 'api_key', 'db_password', 'My-Token'];
const SEPARATORS = [': ', ':', '= ', ' = ', ':\t', ':\n', '\n: ', ':    '];
const SCHEMES = ['Bearer', 'Basic', 'Digest', 'Negotiate', 'Token', 'AWS4-HMAC-SHA256', 'bearer', 'aws4-hmac-sha256'];
const VALUE_FORMS = {
  'bare token': (secret) => secret,
  'quoted token': (secret) => `"${secret}"`,
  'parameter list': (secret) => `username="alice", realm="test", nonce="${secret}", response="${secret}"`,
  'token then trailing prose': (secret) => `${secret} then the request was retried`,
};

// Ordinary prose that contains a scheme word, a key word or both.
const NOT_CREDENTIALS = [
  'a basic explanation follows',
  'the tokenizer ran',
  'passwordless login enabled',
  'the authorization model is basic',
  'authorization check failed: basic role required',
  'Proxy-Authorization subsystem unavailable',
  'database authorization failed; Basic role required',
  'Authorization header missing',
  'token bucket refilled on every request',
  'api_key rotation policy documented',
  'the "quoted" word',
];

function runner() {
  return {
    snapshot: () => [],
    define: () => ({ pluginId: 'evolved-plugin', packageId: 'evolved-package' }),
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => ({ ok: true }),
    undefine: async () => ({ ok: true }),
  };
}

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-review-scheme-'));
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

test('every shape the third review reproduced loses its credential material', () => {
  for (const { text, summary } of AUDIT_SHAPES) {
    assert.equal(summaryOf(text), summary, `${text} -> ${summaryOf(text)}`);
    assert.equal(summaryOf(text).includes(SECRET), false, `${text} still leaks the credential`);
  }
});

test('the key x separator x scheme x value-form matrix keeps no fragment of the credential', () => {
  const cases = [];
  for (const key of KEYS) {
    for (const separator of SEPARATORS) {
      for (const scheme of SCHEMES) {
        for (const [form, build] of Object.entries(VALUE_FORMS)) {
          // The two parameter-list schemes are the ones a list follows in
          // practice, but every scheme is exercised with every value form.
          cases.push({ key, separator, scheme, form, text: `${key}${separator}${scheme} ${build(SECRET)}` });
        }
      }
    }
  }
  assert.equal(cases.length, KEYS.length * SEPARATORS.length * SCHEMES.length * Object.keys(VALUE_FORMS).length,
    'the matrix enumerates every axis combination, it does not sample');
  const leaked = [];
  for (const entry of cases) {
    const summary = summaryOf(entry.text);
    if (summary.includes(SECRET) || !summary.includes('[redacted]')) leaked.push({ ...entry, summary });
  }
  assert.deepEqual(leaked, [], `combinations that kept the credential: ${JSON.stringify(leaked.slice(0, 5))}`);
});

test('the whole value is consumed as one unit, and the prose after it is withheld with it', () => {
  // Multi-line, exactly as the audit rendered it.
  const multiLine = `Authorization: Digest username="alice", realm="test",\n  nonce="${SECRET}", response="${SECRET}"`;
  assert.equal(summaryOf(multiLine), 'Authorization: [redacted]');
  // No inner grammar ends the value: a header followed by a sentence redacts the
  // sentence too. That is the accepted trade-off of the whole-value rule — a
  // diagnostic detail must never cost a credential — asserted rather than assumed.
  assert.equal(
    summaryOf(`Authorization: Digest username="alice", nonce="${SECRET}" and the host was unreachable`),
    'Authorization: [redacted]',
  );
  // An unquoted certificate-style list, and an AWS credential scope: material
  // after the last recognised pair goes with the value.
  assert.equal(summaryOf(`Authorization: Signature keyId=key1,algorithm=rsa-sha256,signature=${SECRET} extra=kept`), 'Authorization: [redacted]');
  // A JSON body keeps its key prefix and gains no truncated remainder: as of round
  // 7 the value is the whole remainder, so the closing quote and the enclosing
  // brace go with it. The fragment is not a JSON document any more; that is the
  // accepted cost, asserted here rather than assumed.
  assert.equal(summaryOf(`{"Authorization":"Basic ${SECRET}"}`), '{"Authorization":[redacted]');
  assert.throws(() => JSON.parse(summaryOf(`{"Authorization":"Basic ${SECRET}"}`)), SyntaxError,
    'the accepted cost: the fragment no longer parses');
  assert.equal(summaryOf(`{"Authorization":"Digest nonce=\\"${SECRET}\\""}`), '{"Authorization":[redacted]');
  // A quoted value is no longer closed by the quote that opened it; it is claimed to
  // the end of the text like every other value.
  assert.equal(summaryOf(`Authorization: "Bearer ${SECRET}"`), 'Authorization: [redacted]');
});

test('a failed Trial keeps every scheme-bearing credential out of the archive, the bridge, the memory and inspect', async (t) => {
  for (const { text } of AUDIT_SHAPES) {
    const root = await scratch(t);
    const ctx = context();
    ctx.dynamicCordisRunner = runner();
    const core = new EvolutionOrchestrator(ctx, {
      presetDir: root,
      startupDrift: false,
      eventBridgePath: path.join(root, 'events.jsonl'),
      eventBridgeKey: 'k'.repeat(32),
      driftStatePath: path.join(root, 'drift.json'),
      memoryPath: path.join(root, 'memory.json'),
    });
    const exec = { agent: { id: 'review-owner' }, signal: new AbortController().signal };
    const proposal = core.propose({ why: 'review-scheme-redaction', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
    core.runner.run = async () => { throw new Error(text); };
    await assert.rejects(
      core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
      (error) => error.message === text,
      'the caller still receives the real error; only persistence is bounded',
    );

    const [archiveFile] = await markdownFiles(root);
    assert.ok(archiveFile, `the failed trial is archived: ${text}`);
    const archive = await readText(archiveFile);
    const bridge = await readText(path.join(root, 'events.jsonl'));
    const memory = await readText(path.join(root, 'memory.json'));
    const inspect = JSON.stringify(core.inspect(exec.agent));
    const record = JSON.stringify(core.experiments.get(proposal.experimentId)?.failure ?? 'released');

    for (const [where, body] of Object.entries({ archive, bridge, memory, inspect, record })) {
      assert.equal(body.includes(SECRET), false, `${where} persisted the credential from ${JSON.stringify(text)}`);
    }
    // The record is still useful after redaction: classification, digest and the
    // header name a reader needs to know a credential was present.
    assert.match(archive, /"errorCategory": "runtime-trial"/, 'the archive keeps the failure classification');
    assert.match(archive, /"errorDigest": "sha256:[0-9a-f]{16}"/, 'the archive keeps the irreversible identity');
    assert.match(archive, /\[redacted\]/, 'the archive marks the redaction');
    const failureEvent = bridge.trim().split('\n')
      .map((line) => JSON.parse(line))
      .map((envelope) => envelope.event || envelope)
      .find((event) => event?.eventType === 'failure-learned');
    assert.ok(failureEvent, `failure-learned is emitted: ${text}`);
    assert.equal(failureEvent.failure?.errorSummary.includes(SECRET), false, 'the event carries the redacted summary');
  }
});

test('prose that merely contains a scheme or a key word is left verbatim', () => {
  for (const text of NOT_CREDENTIALS) {
    assert.equal(summaryOf(text), text, `no credential shape is present, the text must survive: ${text}`);
  }
});

test('the boundary that is still not covered is exactly what the rule documents', async () => {
  // A vendor scheme is covered when it introduces a parameter list, whatever it
  // is called.
  assert.equal(summaryOf(`token: X-Custom-Scheme username="alice", nonce="${SECRET}"`).includes(SECRET), false,
    'an unrecognized scheme that introduces a parameter list is still credential material');
  // The single-opaque-token form used to be the residual this test asserted. The
  // fifth review reproduced it in the wild (`token: X-Custom-Scheme <material>`
  // reached events.jsonl and the archive), so the bare value is now redacted
  // without consulting a scheme list at all and the residual is closed. The
  // assertion is kept, inverted, so a regression is not silent.
  assert.equal(summaryOf(`token: X-Custom-Scheme ${SECRET}`).includes(SECRET), false,
    'a scheme word outside the recognized set no longer keeps the material it introduces');
  assert.equal(summaryOf(`token: X-Custom-Scheme ${SECRET}`), 'token: [redacted]');
  // What is left is enumerated and asserted in one place, so this file cannot
  // drift from the rules: review-fix-redaction-escape-unknown-scheme.test.mjs
  // owns the wrapper/whitespace/key/separator/scheme/value-form matrix and the
  // residual list.

  // One credential boundary implementation, one rule table: the fix must not
  // introduce a second scrubber next to the shared one.
  const source = await fs.readFile(path.join(REPO_ROOT, 'lib/orchestrator.js'), 'utf8');
  const count = (needle) => source.split(needle).length - 1;
  assert.equal(count('const CREDENTIAL_TEXT_PATTERNS = ['), 1, 'there is exactly one pattern table');
  assert.equal(count('function redactCredentialShapes('), 1, 'there is exactly one redaction function');
  // The key-aware rule in `compactValue` (round 2) reuses this same list instead
  // of carrying a second, hand-maintained array of spellings: the whole-key
  // predicate is built from `CREDENTIAL_KEY`, and no spelling is written twice.
  assert.equal(count('const CREDENTIAL_KEY = ['), 1, 'there is exactly one credential key list');
  assert.equal(count('String.raw`password`'), 1, 'no key spelling is maintained in a second list');
  assert.equal(count('(?:${CREDENTIAL_KEY})s?$'), 1, 'the whole-key predicate is derived from the same list');
  // Round 4: `safeErrorEvidence` is the second *structural* walker in this module
  // (the proof/rollback boundary), and it reuses that same predicate instead of
  // growing a third rule. Exactly one definition, and exactly the two structural
  // call sites that need it - `compactValue` and `safeErrorEvidence`.
  assert.equal(count('function isCredentialKeyName('), 1, 'there is exactly one key predicate');
  assert.equal(count('if (isCredentialKeyName(key)) {'), 2, 'both structural boundaries decide on the one predicate');
});
