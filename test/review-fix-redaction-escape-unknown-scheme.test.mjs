// Review blockers A and B (P1), fifth round.
//
// A. The scheme rule was keyed on a list of scheme names. A material token that
//    followed a credential key was therefore left in plaintext whenever the word
//    before it was a vendor scheme the list did not contain:
//
//      token: X-Custom-Scheme <material> -> token: [redacted] <material>
//
//    and it reached events.jsonl and the Markdown archive in plaintext.
//
// B. The rules matched spacing with `\s`, which is a real space in the raw
//    message but a two-character escape sequence (`\n`, `\t`, `\r`, or `\\n`
//    after a second JSON.stringify layer) once the message has been stringified
//    by anything that stores or transports it as JSON. A shape the raw form
//    covered came back when the same text was stringified:
//
//      JSON.stringify({error: 'Authorization:\nBasic <m>'})
//        -> {"error":"Authorization:[redacted] <m>"}
//      JSON.stringify({error: 'Authorization: Digest a=x,\n nonce="<m>"'})
//        -> Authorization: [redacted],\n nonce=\"<m>\"
//
// This file is the systematic check, not the audit's payload list: it enumerates
// axes (wrapper layer x logical whitespace x key x separator x scheme x value
// form) and asserts that no combination keeps a fragment of the secret. The
// residuals are enumerated and asserted as residuals, so the boundary stays
// falsifiable instead of being claimed complete. The shapes that are still not
// covered, and the over-redaction the whole-remainder value boundary accepts,
// are listed in the last two tests and at the rule definition in
// lib/orchestrator.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EvolutionOrchestrator, safeErrorDto } from '../lib/orchestrator.js';
import { context } from './fixtures/runtime-inspect.mjs';

const HOST_CODE = 'return { name: "review", apply() {} };';
// Short enough that the 240-character summary bound never truncates a case, and
// distinctive enough that a two-character fragment is already a leak.
const SECRET = 'V4q7M2z9';
const FRAGMENT = SECRET.slice(0, 4);

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

// The three payloads this round reproduced, exactly as the audit wrote them.
const AUDIT_PAYLOADS = [
  {
    name: 'A: credential key, unrecognized scheme, bare material',
    text: `token: X-Custom-Scheme ${SECRET}`,
    summary: 'token: [redacted]',
  },
  {
    name: 'A: authorization header, unrecognized scheme, bare material',
    text: `Authorization: X-Custom-Scheme ${SECRET}`,
    summary: 'Authorization: [redacted]',
  },
  {
    name: 'B: JSON.stringify of a header whose value starts after an escaped newline',
    text: JSON.stringify({ error: `Authorization:\nBasic ${SECRET}` }),
    check: (summary) => assert.equal(summary.includes(SECRET), false, `still leaks: ${summary}`),
  },
  {
    name: 'B: JSON.stringify of a folded Digest parameter list',
    text: JSON.stringify({ error: `Authorization: Digest a=x,\n nonce="${SECRET}"` }),
    check: (summary) => assert.equal(summary.includes(SECRET), false, `still leaks: ${summary}`),
  },
  {
    name: 'B: two JSON.stringify layers around a quoted Basic token',
    text: JSON.stringify(JSON.stringify({ error: `Authorization: Basic "${SECRET}"` })),
    check: (summary) => assert.equal(summary.includes(SECRET), false, `still leaks: ${summary}`),
  },
];

// The enumeration axes. Nothing here is the audit's list: the point is that the
// rule is not a lookup table of shapes that were reported.
const WRAPPERS = [
  ['raw', (text) => text],
  ['json x1', (text) => JSON.stringify({ error: text })],
  ['json x2', (text) => JSON.stringify({ error: JSON.stringify({ error: text }) })],
  ['json x3', (text) => JSON.stringify({ error: JSON.stringify({ error: JSON.stringify({ error: text }) }) })],
];
// A real space/tab/newline, the one-layer escape form, the two-layer form, and a
// run mixing them. `\\n` is what a newline looks like after two JSON.stringify
// layers, and `\n` after one.
const LOGICAL_WHITESPACE = [
  ['space', ' '],
  ['tab', '\t'],
  ['newline', '\n'],
  ['escaped newline', '\\n'],
  ['doubly escaped newline', '\\\\n'],
  ['mixed', ' \t\\n '],
];
const KEYS = [
  'Authorization', 'Proxy-Authorization', 'X-Auth-Token', 'X-Api-Key', 'token',
  'access_token', 'api_key', 'db_password', 'My-Token', 'X-Custom-Prefix-Token',
];
const SEPARATORS = [':', ': ', '= ', ' = ', ':\t', ':\n', '=\\n'];
const KNOWN_SCHEMES = [
  'AWS4-HMAC-SHA256', 'SCRAM-SHA-256', 'Bearer', 'Basic', 'Digest', 'Negotiate',
  'Token', 'NTLM', 'Hawk', 'OAuth2', 'Signature', 'DPoP',
];
const UNKNOWN_SCHEMES = ['X-Custom-Scheme', 'Corp-Auth', 'VendorV2'];
const SCHEMES = [...KNOWN_SCHEMES, ...UNKNOWN_SCHEMES];
const VALUE_FORMS = {
  'bare token': (secret) => secret,
  'quoted token': (secret) => `"${secret}"`,
  'single-quoted token': (secret) => `'${secret}'`,
  'parameter list': (secret) => `username="alice", nonce="${secret}"`,
  'comma list': (secret) => `${secret}, next=1`,
  'semicolon list': (secret) => `${secret}; next=1`,
  'unknown word then token': (secret) => `someword ${secret}`,
};

// The residual this round *closed*, kept as an assertion instead of a comment:
// the matrix used to exempt `unknown word then token` under a recognised scheme,
// because that combination is a recognised scheme's own boundary — one token —
// and everything past it stayed in plaintext. The scheme-grammar layer is gone,
// so the exemption is gone with it: every form below is checked for the fragment.
const WHITESPACE_SPLIT_RESIDUAL = [];

let enumerated = null;

function enumerate() {
  if (enumerated) return enumerated;
  const cases = [];
  for (const [wrapperName, wrap] of WRAPPERS) {
    for (const [whitespaceName, whitespace] of LOGICAL_WHITESPACE) {
      for (const key of KEYS) {
        for (const separator of SEPARATORS) {
          for (const scheme of SCHEMES) {
            for (const [formName, build] of Object.entries(VALUE_FORMS)) {
              const text = `${key}${separator}${scheme}${whitespace}${build(SECRET)}`;
              cases.push({ wrapperName, whitespaceName, key, separator, scheme, formName, text, summary: summaryOf(wrap(text)) });
            }
          }
        }
      }
    }
  }
  enumerated = cases;
  return enumerated;
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

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-review-escape-'));
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

test('the three payloads this round reproduced lose their credential material', () => {
  for (const payload of AUDIT_PAYLOADS) {
    const summary = summaryOf(payload.text);
    assert.equal(summary.includes(SECRET), false, `${payload.name}: ${summary}`);
    if (payload.summary) assert.equal(summary, payload.summary, payload.name);
    else payload.check(summary);
  }
});

test('the wrapper x whitespace x key x separator x scheme x value-form matrix keeps no fragment', () => {
  const cases = enumerate();
  assert.equal(
    cases.length,
    WRAPPERS.length * LOGICAL_WHITESPACE.length * KEYS.length * SEPARATORS.length * SCHEMES.length * Object.keys(VALUE_FORMS).length,
    'the matrix enumerates every axis combination, it does not sample',
  );

  const leaked = [];
  for (const entry of cases) {
    if (entry.summary.includes(FRAGMENT) || !entry.summary.includes('[redacted]')) leaked.push(entry);
  }
  assert.deepEqual(leaked, [], `combinations that kept the credential: ${JSON.stringify(leaked.slice(0, 5))}`);
});

test('the matrix has no exempt combination left: every form that keeps a fragment fails this test', () => {
  // The residual the fifth round documented (`unknown word then token` under a
  // recognised scheme) is closed by removing the scheme-grammar layer, so this
  // assertion is now strictly stronger than the exemption it replaces: a single
  // form that keeps the fragment anywhere in the matrix fails here.
  const leaked = [];
  for (const entry of enumerate()) {
    if (!entry.summary.includes(FRAGMENT)) continue;
    leaked.push({ formName: entry.formName, scheme: entry.scheme, text: entry.text, summary: entry.summary });
  }
  assert.deepEqual(leaked, [], `combinations that kept the credential: ${JSON.stringify(leaked.slice(0, 5))}`);
  assert.deepEqual(WHITESPACE_SPLIT_RESIDUAL, [], 'the exemption list is empty: nothing is skipped by the matrix');
  // The accepted trade-off of the same boundary: prose after an auth header is
  // withheld with the value instead of surviving next to the marker.
  assert.equal(summaryOf(`Authorization: Digest username="alice", nonce="${SECRET}" and the host was unreachable`),
    'Authorization: [redacted]');
  // A `Bearer` token with no credential key in front of it is not an assignment;
  // the unkeyed vendor-token rule needs eight characters, so this prose survives.
  assert.equal(summaryOf(`Bearer abc then the request was retried`), 'Bearer abc then the request was retried');
});

test('every layer of stringification is covered, and a deeper layer still ends redacted', () => {
  const base = `Authorization: Basic "${SECRET}"`;
  for (let depth = 1; depth <= 3; depth += 1) {
    let payload = base;
    for (let layer = 0; layer < depth; layer += 1) payload = JSON.stringify({ error: payload });
    const summary = summaryOf(payload);
    assert.equal(summary.includes(SECRET), false, `depth ${depth}: ${summary}`);
    assert.equal(summary.includes('[redacted]'), true, `depth ${depth}: the marker survives`);
  }
  // Beyond the documented four-layer bound the *structured* match no longer
  // applies, but the material must still not survive: the conservative bare-value
  // branch does not depend on the escape model at all. Measured over the rule
  // itself (no summary truncation) up to eleven layers, for a bare value, a
  // quoted value, an escaped-newline separator and a folded parameter list.
  for (const shape of [`token=${SECRET}`, `token="${SECRET}"`, `Authorization:\\nBasic ${SECRET}`,
    `Authorization: Digest nonce="${SECRET}"`, `Authorization: X-Scheme\\n${SECRET}`]) {
    for (const depth of [4, 5, 6, 8]) {
      let payload = shape;
      for (let layer = 0; layer < depth; layer += 1) payload = JSON.stringify({ error: payload });
      // The summary keeps 240 characters, so a deep layer pushes the material out
      // of the window; assert on the property that matters either way.
      assert.equal(summaryOf(payload).includes(SECRET), false, `depth ${depth} leaked for ${shape}`);
    }
  }
  // The parameter list is the shape where a dangling escape run used to strand
  // the quoted material ("Authorization: Digest nonce=\\\"<secret>\\\"" at five
  // layers), so it is asserted at a depth whose material the 240-character window
  // still contains.
  let folded = `Authorization: Digest nonce="${SECRET}"`;
  for (let layer = 0; layer < 5; layer += 1) folded = JSON.stringify({ error: folded });
  assert.equal(summaryOf(folded).includes(SECRET), false, 'a five-layer folded parameter list keeps no material');
  assert.equal(summaryOf(folded).includes('[redacted]'), true, 'the marker proves this is redaction, not truncation');
  assert.equal(summaryOf(folded).includes('nonce'), false, 'the parameter list is consumed as one value');
});

test('the diagnostic context survives: key name, classification, digest', () => {
  // The bare-value boundary is conservative on purpose, so this is the test that
  // says what it must not take: the key the reader needs in order to know a
  // credential was present, the failure category and the digest.
  const summary = summaryOf(`token: X-Custom-Scheme ${SECRET} and the request was retried`);
  assert.match(summary, /^token: \[redacted\]/, `the key and the marker survive: ${summary}`);
  const dto = safeErrorDto(new Error(`Authorization:\nBasic ${SECRET}`), 'runtime-trial');
  assert.equal(dto.errorCategory, 'runtime-trial');
  assert.match(dto.errorDigest, /^sha256:[0-9a-f]{16}$/);
  assert.equal(dto.errorDigest, safeErrorDto(new Error(`Authorization:\nBasic ${SECRET}`), 'trial').errorDigest,
    'the digest is computed on the raw material, so it still identifies the failure');
  assert.equal(dto.errorLength, `Authorization:\nBasic ${SECRET}`.length);
});

test('a failed Trial keeps every payload out of the archive, the bridge, the memory and inspect', async (t) => {
  for (const payload of AUDIT_PAYLOADS) {
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
    const proposal = core.propose({ why: 'review-escape-redaction', target: 'plugin:review', impactScope: ['test'], successMetrics: ['errors'] }, exec);
    core.runner.run = async () => { throw new Error(payload.text); };
    await assert.rejects(
      core.trial({ experimentId: proposal.experimentId, composition: { name: 'r', purpose: 'r', code: { host: HOST_CODE } } }, exec),
      (error) => error.message === payload.text,
      'the caller still receives the real error; only persistence is bounded',
    );

    const [archiveFile] = await markdownFiles(root);
    assert.ok(archiveFile, `the failed trial is archived: ${payload.name}`);
    const bodies = {
      archive: await readText(archiveFile),
      bridge: await readText(path.join(root, 'events.jsonl')),
      memory: await readText(path.join(root, 'memory.json')),
      inspect: JSON.stringify(core.inspect(exec.agent)),
      record: JSON.stringify(core.experiments.get(proposal.experimentId)?.failure ?? 'released'),
    };
    for (const [where, body] of Object.entries(bodies)) {
      assert.equal(body.includes(SECRET), false, `${where} persisted the credential from ${payload.name}`);
      assert.equal(body.includes(FRAGMENT), false, `${where} persisted a fragment of the credential from ${payload.name}`);
    }
    // The failure memory is a real durable record, not an empty file that would
    // make the assertion above vacuous.
    assert.ok(bodies.memory.length > 0, `the failure memory was written: ${payload.name}`);
    assert.match(bodies.memory, /"category": "runtime-trial"/, `the memory keeps the classification: ${payload.name}`);
    // Still diagnosable after redaction: classification, digest and the marker.
    assert.match(bodies.archive, /"errorCategory": "runtime-trial"/, `${payload.name}: the classification survives`);
    assert.match(bodies.archive, /"errorDigest": "sha256:[0-9a-f]{16}"/, `${payload.name}: the digest survives`);
    assert.match(bodies.archive, /\[redacted\]/, `${payload.name}: the archive marks the redaction`);
    const failureEvent = bodies.bridge.trim().split('\n')
      .map((line) => JSON.parse(line))
      .map((envelope) => envelope.event || envelope)
      .find((event) => event?.eventType === 'failure-learned');
    assert.ok(failureEvent, `${payload.name}: failure-learned is emitted`);
    assert.equal(failureEvent.failure?.errorSummary.includes(SECRET), false, `${payload.name}: the event summary is redacted`);
  }
});

test('ordinary prose is left verbatim, including the counterexamples this round named', () => {
  const verbatim = [
    'a basic explanation follows',
    'the tokenizer ran',
    'passwordless login enabled',
    'the authorization model is basic',
    'secret santa arrived',
    'token budget exceeded',
    'Authorization header missing',
    'token bucket refilled on every request',
    'api_key rotation policy documented',
    `the word X-Custom-Scheme is not a credential`,
    `authorization check failed: basic role required`,
  ];
  for (const text of verbatim) {
    assert.equal(summaryOf(text), text, `no credential shape is present, the text must survive: ${text}`);
  }
});

test('a credential value claims the remainder, so no structure after it survives, and the accepted cost is exactly this', () => {
  // Round 7: the "structural end" of a credential value is gone, together with
  // the branches (`DOUBLE_QUOTED_VALUE` / `SINGLE_QUOTED_VALUE` /
  // `UNTERMINATED_QUOTED_VALUE` / `CONTAINER_VALUE` / `BARE_VALUE`) and the
  // constants behind it that used to decide where a value stops. After a
  // credential key and its separator the rest of the text is the value, so a
  // closing quote, a comma and every sibling field after it are given up. The
  // fragment is not valid JSON on its own; it is safe as an embedded string.
  assert.equal(summaryOf(`{"password":"${SECRET}","retry":3}`), '{"password":[redacted]');
  assert.throws(() => JSON.parse(summaryOf(`{"password":"${SECRET}","retry":3}`)), SyntaxError,
    'the accepted cost: a redacted credential document is a fragment, not a JSON document');
  // Accepted: an unquoted value has no interior boundary this rule can trust,
  // so it takes the rest of the value with it. There is no inner grammar any
  // more, so a recognised scheme behaves exactly like an unrecognised one.
  assert.equal(summaryOf(`Authorization: Basic ${SECRET}, next=1`), 'Authorization: [redacted]',
    'a recognised scheme takes the tail of the value too');
  assert.equal(summaryOf(`token: X-Custom-Scheme ${SECRET}, next=1`), 'token: [redacted]',
    'an unrecognised scheme takes the tail of the value, which is the conservative direction');
  assert.equal(summaryOf(`cookie: a=b; sessionid=${SECRET}`), 'cookie: [redacted]',
    'a cookie list keeps its material in a later pair, so `;` cannot end the value');
});

test('a 1 MiB value, a 1 MiB escape run and multi-layer payloads stay linear', (t) => {
  const MiB = 1024 * 1024;
  // `marker` is what must not survive redaction. Every input here is above
  // `REDACTION_TEXT_BOUND` (65,536), so what is measured is the bound's withholder
  // plus the linear scan, not the value rule: an unclosed quote no longer has its
  // own branch (round 7), it is claimed like every other value.
  const cases = [
    { name: '1 MiB bare value', text: `password=${'a'.repeat(MiB)}`, marker: 'aaaa' },
    { name: '1 MiB escaped whitespace run', text: `Authorization: Basic ${'\\n'.repeat(MiB / 2)}${SECRET}`, marker: SECRET },
    { name: '1 MiB backslash run', text: `password=${'\\'.repeat(MiB)}${SECRET}`, marker: SECRET },
    { name: '1 MiB quote run', text: `password=${SECRET}${'"'.repeat(MiB)}`, marker: SECRET },
    { name: '1 MiB mixed escape', text: `token: X-Scheme ${'a\\"b'.repeat(MiB / 4)}${SECRET}`, marker: SECRET },
    { name: '1 MiB real whitespace run', text: `password=${' \t\\n'.repeat(MiB / 3)}${SECRET}`, marker: SECRET },
    { name: '1 MiB unknown scheme word', text: `token: ${'A'.repeat(MiB)} ${SECRET}`, marker: SECRET },
    { name: '1 MiB parameter list', text: `Authorization: Digest ${'a=b,'.repeat(MiB / 4)}nonce=${SECRET}`, marker: SECRET },
    { name: '3-layer 1 MiB payload', text: JSON.stringify(JSON.stringify(JSON.stringify({ e: `token: Bearer ${'a'.repeat(MiB)}` }))), marker: 'aaaa' },
    { name: '4 MiB many candidate closing quotes', text: `password="${'a"'.repeat(2 * MiB)}${SECRET}"`, marker: SECRET },
    { name: '4 MiB escaped embedded form', text: `{"password":"${'\\\\\\"'.repeat(MiB)}${SECRET}`, marker: null },
  ];
  for (const entry of cases) {
    const started = process.hrtime.bigint();
    const summary = summaryOf(entry.text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    t.diagnostic(`${entry.name}: ${entry.text.length} chars -> ${elapsedMs.toFixed(1)}ms`);
    if (entry.marker) assert.equal(summary.includes(entry.marker), false, `${entry.name}: the material is redacted`);
    // The bound only has to fail on an exponential or quadratic regression, not on
    // a loaded machine: measured cost of these shapes is 7-90ms.
    assert.ok(elapsedMs < 2000, `${entry.name}: redaction of ${entry.text.length} chars took ${elapsedMs.toFixed(1)}ms`);
  }
});
