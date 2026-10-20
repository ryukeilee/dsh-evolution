// Review round 7: the convergent fix. Three adversarial passes each found a
// different way for the credential-assignment *value* rule to stop early and
// leave material behind — scheme-grammar boundaries, then container/quoted/
// semicolon forms, then marker forms — and each round widened the same concept:
// "find the structural end of the value so that sibling fields survive".
//
//   safeErrorDto(new Error('password=x]Q7v9ThirdPassSecret3'), 'p').errorSummary
//     -> password=[redacted]]Q7v9ThirdPassSecret3          LEAK
//   safeErrorDto(new Error('password=x}"Q7v9ThirdPassSecret3"'), 'p').errorSummary
//     -> password=[redacted]}"Q7v9ThirdPassSecret3"        LEAK
//
// The concept is the defect, not any one boundary. Once a credential key and its
// separator match (`CREDENTIAL_ASSIGNMENT`), the value is now *everything up to
// the end of the text*: no structural end, no quote pairing, no container
// balancing, no first-character restriction. The replacement is the assignment
// prefix plus `[redacted]`, so nothing of the value is kept and the value cannot
// leak. The branches and constants that existed only to serve the structural-end
// idea (`QUOTED_RUN`, `STRUCTURAL_VALUE_END`, `VALUE_TAIL`, `BARE_VALUE`,
// `DOUBLE_QUOTED_VALUE`, `SINGLE_QUOTED_VALUE`, `UNTERMINATED_QUOTED_VALUE`,
// `CONTAINER_VALUE`) are deleted, so this round reduces the pattern surface.
//
// Accepted costs, asserted below rather than hidden: `{"password":"x","retry":3}`
// renders as `{"password":[redacted]` — the closing quote, the comma and every
// sibling field are gone, and the fragment is not valid JSON on its own — and any
// text after a credential assignment on a later line goes too. Those are
// diagnostic losses, deliberately traded for a boundary that cannot truncate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeErrorDto } from '../lib/orchestrator.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'Q7v9FourthPassSecret9';
// Fragments a truncated value leaves behind. Every one of them must be absent.
const FRAGMENTS = ['Q7v9', 'FourthPass', 'PassSecret', 'Secret9'];

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

/** Exact expectation: the text up to the separator survives, everything after it does not. */
function expectedFor(text, keyName = 'password') {
  const keyAt = text.indexOf(keyName);
  assert.notEqual(keyAt, -1, `the case must contain the credential key: ${text}`);
  const separatorAt = text.slice(keyAt).search(/[:=]/);
  assert.notEqual(separatorAt, -1, `the case must contain a separator after the key: ${text}`);
  return `${text.slice(0, keyAt + separatorAt + 1)}[redacted]`;
}

function assertClaimedWhole(text, label, keyName = 'password') {
  const summary = summaryOf(text);
  assert.equal(summary, expectedFor(text, keyName), `${label}: the value is the whole remainder`);
  for (const fragment of FRAGMENTS) {
    assert.equal(summary.includes(fragment), false, `${label}: ${fragment} survived`);
  }
  assert.equal(summary.includes(SECRET), false, `${label}: the credential survived`);
  // Idempotence is proven, not assumed: the projection is a fixed point.
  assert.equal(summaryOf(summary), summary, `${label}: a second projection changed the text`);
  return summary;
}

// ---------------------------------------------------------------------------
// 1. The shapes the round-7 review reproduced.
// ---------------------------------------------------------------------------

test('the shapes the round-7 review reproduced lose the value at the separator', () => {
  const cases = [
    ['a `]` inside the value', `password=x]${SECRET}`],
    ['a `}` and a quoted continuation', `password=x}"${SECRET}"`],
    ['a comma inside the value', `password=x,${SECRET}`],
    ['a `]`, a `;` and a quoted sibling', `password=x];"${SECRET}"`],
  ];
  for (const [label, text] of cases) {
    assert.equal(assertClaimedWhole(text, label), 'password=[redacted]', `${label}: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Every character and pair the old rule treated as a structural end.
// ---------------------------------------------------------------------------

test('every structural end the old rule offered is inside the value now', () => {
  // Each entry is what used to be read as the end of the value: a closing
  // bracket, a closing brace, either quote, a comma, and the two JSON separator
  // forms (`,"key":` and `,"key"`). None of them ends anything now.
  const shapes = [
    'x]', 'x}', 'x"', "x'", 'x,', 'x];', 'x}"', "x']", 'x]]', 'x}}',
    'x,"x":', 'x,"x"', "x,'x':", 'x, "x" :', 'x};', 'x,:', 'x};',
  ];
  for (const shape of shapes) {
    assertClaimedWhole(`password=${shape}${SECRET}`, `structural character ${JSON.stringify(shape)}`);
  }
  // The same characters one position later, so the rule cannot depend on the
  // first character of the value being "ordinary" either.
  for (const shape of shapes) {
    assertClaimedWhole(`password=pre${shape}${SECRET}`, `structural character after a prefix ${JSON.stringify(shape)}`);
  }
  // As the *first* character of the value, which the old rule refused outright:
  // a value beginning with a structural end was never claimed at all, so the
  // whole secret survived verbatim with no marker anywhere.
  for (const first of [']', '}', '"', "'", ',', '};', ']};']) {
    assert.equal(
      assertClaimedWhole(`password=${first}${SECRET}`, `structural end as the first character ${JSON.stringify(first)}`),
      'password=[redacted]',
      `${first} must not prevent the value from being claimed`,
    );
  }
  // A quoted value whose body contains the opening quote character again — the
  // shape that used to end the match at the second quote and keep the rest.
  assert.equal(assertClaimedWhole(`password="{"a":1}${SECRET}`, 'a quoted body containing a quote'), 'password=[redacted]');
});

// ---------------------------------------------------------------------------
// 3. Container and marker forms.
// ---------------------------------------------------------------------------

test('container forms and marker forms are claimed whole', () => {
  const cases = [
    ['an object container with an inner close before the secret', `credentials={"a":{},"value":"${SECRET}"}`, 'credentials'],
    ['a nested object container', `credentials={"a":{"b":{"value":"${SECRET}"}}}`, 'credentials'],
    ['an array container', `api_key=["a",["b"],"${SECRET}"]`, 'api_key'],
    ['a marker-led container', `password=[[redacted],"${SECRET}"]`, 'password'],
    ['a marker-led brace container', `credentials={"[redacted]":"${SECRET}"}`, 'credentials'],
    ['a document whose credential field carries the marker', `payload={"credentials":[[redacted],"${SECRET}"]}`, 'credentials'],
    ['a container followed by a sibling field', `{"password":{"a":1},"retry":3}`, 'password'],
    // The old rule also refused a value that *opens* with a container terminator,
    // so this one survived verbatim with no marker at all.
    ['a container that opens with a terminator', `password=]{"a":1}${SECRET}`, 'password'],
  ];
  for (const [label, text, key] of cases) {
    const summary = assertClaimedWhole(text, label, key);
    assert.equal(summary, expectedFor(text, key), `${label}: claimed to the end`);
  }
});

// ---------------------------------------------------------------------------
// 4. Escaped and JSON-embedded forms, 1 to 4 layers.
// ---------------------------------------------------------------------------

test('escaped and JSON-embedded forms at 1 to 4 layers lose the value', () => {
  const bases = [
    { text: `password=x]${SECRET}`, key: 'password' },
    { text: `password=x}"${SECRET}"`, key: 'password' },
    { text: `credentials={"a":{},"value":"${SECRET}"}`, key: 'credentials' },
    { text: `"password":"${SECRET}","retry":3`, key: 'password' },
    { text: `{'password':'${SECRET}'}`, key: 'password' },
  ];
  for (const base of bases) {
    let layered = base.text;
    for (let layer = 1; layer <= 4; layer += 1) {
      layered = JSON.stringify(layered);
      // The escape prefix on the key is `\\{0,15}["']`, which is exactly why four
      // layers are the documented bound and a fifth is outside it.
      assertClaimedWhole(layered, `layer ${layer} of ${base.text}`, base.key);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. The accepted cost, pinned in the fail-closed direction.
// ---------------------------------------------------------------------------

test('the accepted cost is the closing quote, the comma and every sibling field', () => {
  assert.equal(summaryOf('{"password":"x","retry":3}'), '{"password":[redacted]');
  assert.throws(() => JSON.parse(summaryOf('{"password":"x","retry":3}')), SyntaxError,
    'the fragment is not a JSON document on its own');
  // Multi-line: everything after the assignment on a later line goes with it,
  // which was already true for multi-line messages before this round.
  assert.equal(summaryOf(`Authorization: Digest nonce="${SECRET}"\nand the host was unreachable`), 'Authorization: [redacted]');
  // The diagnostic residue the design keeps: key name, marker, and (outside this
  // rule) the classification and digest the DTO carries.
  const dto = safeErrorDto(new Error(`password=${SECRET}`), 'trial');
  assert.equal(dto.errorSummary, 'password=[redacted]');
  assert.equal(dto.errorDigest.startsWith('sha256:'), true);
});

test('a second projection over any redacted string changes nothing', () => {
  const fixedPoints = [
    'password=[redacted]',
    'credentials=[redacted]',
    'api_key=[redacted]',
    '{"password":[redacted]',
    '{"credentials":[redacted]',
    'Authorization: [redacted]',
    '[redacted]',
  ];
  for (const value of fixedPoints) {
    assert.equal(summaryOf(value), value, `${value} is not a fixed point after one projection`);
    assert.equal(summaryOf(summaryOf(value)), value, `${value} is not a fixed point after two projections`);
  }
  // Every produced summary in the shapes above is itself a fixed point.
  for (const text of [
    `password=x]${SECRET}`,
    `password=x}"${SECRET}"`,
    `credentials={"a":{},"value":"${SECRET}"}`,
    `password=[[redacted],"${SECRET}"]`,
    JSON.stringify(JSON.stringify(`password=x]${SECRET}`)),
  ]) {
    const once = summaryOf(text);
    assert.equal(summaryOf(once), once, `not idempotent: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// 6. The rule has one branch, and the structural-end machinery is gone.
// ---------------------------------------------------------------------------

test('the value rule is the assignment prefix plus a marker, and the structural-end constants are deleted', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'orchestrator.js'), 'utf8');
  for (const name of [
    'STRUCTURAL_VALUE_END', 'VALUE_TAIL', 'BARE_VALUE', 'DOUBLE_QUOTED_VALUE',
    'SINGLE_QUOTED_VALUE', 'UNTERMINATED_QUOTED_VALUE', 'CONTAINER_VALUE', 'QUOTED_RUN',
  ]) {
    assert.equal(source.includes(`const ${name} `), false, `${name} must not be declared any more`);
  }
  // One assignment rule, one claim to the end of the text, one replacement.
  assert.equal(
    source.includes('const CREDENTIAL_VALUE_PATTERN = new RegExp(String.raw`${CREDENTIAL_ASSIGNMENT}[\\s\\S]*`, "gi");'),
    true,
    'the value rule claims the remainder of the text with no alternation',
  );
  assert.equal(source.includes('[CREDENTIAL_VALUE_PATTERN, "$1[redacted]"],'), true,
    'the replacement is the prefix plus the marker, so no byte of the value is re-emitted');
  // `QUOTED` stays: it is the escaped-quote prefix on a quoted *key*, which is a
  // different job from the deleted quoted-value runs.
  assert.equal(source.includes('const QUOTED = String.raw'), true, 'the quoted key prefix is still defined');
});
