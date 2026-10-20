// Review blocker (P1), ninth round: auth-header continuation.
//
// The rule carried a scheme-grammar layer (`AUTH_SCHEME`/`AUTH_PARAM`/
// `AUTH_OPAQUE`) that recognised `Bearer`, `Basic`, `Digest`,
// `AWS4-HMAC-SHA256`, … and replaced exactly the material that scheme's own
// grammar declares: one opaque token after `Bearer`, one `name=value` parameter
// list after `Digest`. Everything the peer actually sent past that boundary was
// left in plaintext, and the conservative bare-value rule after it could not
// re-match, because the value it saw already read `[redacted]`. Four measured
// forms, all of them persisted in plaintext into failure memory, the event
// bridge and the Markdown archive:
//
//   Authorization: Bearer aa <secret>              -> Authorization: [redacted] <secret>
//   Authorization: Bearer aa\"<secret>\"bb          -> Authorization: [redacted]\"<secret>\"bb
//   Authorization: AWS4-… …\nSignature=<secret>    -> Authorization: [redacted]\nSignature=<secret>
//   X-Auth-Token: Bearer aa <secret>               -> X-Auth-Token: [redacted] <secret>
//
// The fix is a deletion, not a wider list: the scheme-grammar layer is gone, and
// every keyed value takes the assignment rule's whole-value path — the same path
// that already covered `token: X-Custom-Scheme <material>`. A scheme-name list is
// an enumeration, and every enumeration is wrong for the next vendor.
//
// The accepted trade-off, asserted in the last test: prose that follows an auth
// header is now withheld together with the value
// (`Authorization: Bearer abc123 and the host was unreachable` -> one marker).
// Keeping a diagnostic detail must never cost a credential.
import test from 'node:test';
import assert from 'node:assert/strict';

import { safeErrorDto } from '../lib/orchestrator.js';

// Short enough that the 240-character summary bound never truncates a case:
// a leak hidden past the bound would not be asserted on.
const SECRET = 'Z7r6Secret9';
const FRAGMENT = SECRET.slice(0, 4);

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

// The four probes the pre-fix code reproduced, with the exact continuation
// material each of them left behind.
const PROBES = [
  {
    name: 'material after the one token `Bearer` introduces',
    text: `Authorization: Bearer aa ${SECRET}`,
    summary: 'Authorization: [redacted]',
    forbidden: [SECRET, FRAGMENT],
  },
  {
    name: 'material behind an escaped quote, which is not an opaque-token character',
    text: `Authorization: Bearer aa\\"${SECRET}\\"bb`,
    summary: 'Authorization: [redacted]',
    forbidden: [SECRET, FRAGMENT],
  },
  {
    name: 'the Signature parameter of a folded AWS4 credential scope',
    text: `Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101/us-east-1/s3/aws4_request\nSignature=deadbeef`,
    summary: 'Authorization: [redacted]',
    forbidden: ['deadbeef', 'AKIAIOSFODNN7EXAMPLE'],
  },
  {
    name: 'a credential key other than `Authorization`',
    text: `X-Auth-Token: Bearer aa ${SECRET}`,
    summary: 'X-Auth-Token: [redacted]',
    forbidden: [SECRET, FRAGMENT],
  },
];

test('every measured auth continuation loses its material and is one marker', () => {
  for (const probe of PROBES) {
    const summary = summaryOf(probe.text);
    assert.equal(summary, probe.summary, `${probe.name}: the value is one redaction, not a prefix of one: ${summary}`);
    for (const fragment of probe.forbidden) {
      assert.equal(summary.includes(fragment), false, `${probe.name}: ${fragment} survived in ${summary}`);
    }
  }
});

test('a continuation is still covered four JSON.stringify layers deep', () => {
  // The assignment rule's escape model is bounded at four layers, and the
  // continuation is ordinary value text, so the depth does not change the result.
  let payload = `Authorization: Bearer aa ${SECRET}`;
  for (let layer = 0; layer < 4; layer += 1) payload = JSON.stringify({ error: payload });
  const summary = summaryOf(payload);
  assert.equal(summary.includes(SECRET), false, `four layers: ${summary}`);
  assert.equal(summary.includes(FRAGMENT), false, `four layers kept a fragment: ${summary}`);
  assert.equal(summary.includes('[redacted]'), true, `four layers: the marker proves redaction, not truncation: ${summary}`);
});

test('the same continuation is closed for Proxy-Authorization and X-Api-Key', () => {
  const cases = [
    ['Proxy-Authorization', `Proxy-Authorization: Bearer aa ${SECRET}`],
    ['X-Api-Key', `X-Api-Key: Bearer aa ${SECRET}`],
    ['token', `token: Bearer aa ${SECRET}`],
    ['api_key with `=`', `api_key=Bearer aa ${SECRET}`],
  ];
  for (const [key, text] of cases) {
    const summary = summaryOf(text);
    assert.equal(summary.includes(SECRET), false, `${key}: the continuation survived: ${summary}`);
    assert.equal(summary.includes(FRAGMENT), false, `${key}: a fragment survived: ${summary}`);
    assert.match(summary, /\[redacted\]/, `${key}: the value is redacted: ${summary}`);
  }
});

test('the rule is still targeted: prose without a credential key is left verbatim', () => {
  // Redaction of a whole value must not degrade into a blanket wipe of any text
  // that mentions a scheme or a header name.
  const verbatim = [
    'the request was retried after the host was unreachable',
    'a basic explanation follows',
    'the tokenizer ran',
    'Authorization header missing',
    'Bearer abc then the request was retried',
    'authorization check failed: basic role required',
    'Proxy-Authorization subsystem unavailable',
    `the word ${SECRET} with no key in front of it is not this boundary's problem`,
  ];
  for (const text of verbatim) {
    assert.equal(summaryOf(text), text, `no keyed assignment is present, the text must survive: ${text}`);
  }
});

test('the accepted trade-off: prose after an auth header is withheld with the value', () => {
  // Asserted rather than assumed, so the trade-off cannot drift back without a
  // test change: the diagnostic sentence is gone, the key and the marker remain.
  assert.equal(summaryOf(`Authorization: Bearer abc123 and the host was unreachable`),
    'Authorization: [redacted]');
  assert.equal(summaryOf(`Authorization: Bearer aa ${SECRET} then the request was retried`),
    'Authorization: [redacted]');
  // A keyed value keeps its key, so the record is still diagnosable.
  assert.match(summaryOf(`Proxy-Authorization: Bearer aa ${SECRET}`), /^Proxy-Authorization: \[redacted\]$/);
});
