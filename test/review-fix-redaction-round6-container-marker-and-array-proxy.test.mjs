// Review round 6: two surgical defects, both reproduced before the fix.
//
// 1. THE CONTAINER BRANCH WAS DEFEATED BY ITS OWN MARKER GUARD. That branch and
//    its guard are gone as of round 7: after a credential key and its separator
//    the rest of the text is the value, so there is no second branch left to
//    defeat. The expectations below are unchanged, because they were already the
//    fail-closed ones.
//
//    `CONTAINER_VALUE` carried `(?!\[redacted\])` *after* the opening `[`/`{`,
//    so the guard tested the text following the bracket instead of the value it
//    was supposed to skip. The only input it ever fired on was a value that
//    itself starts with the marker, and firing there made the container branch
//    fail, so a shorter alternative (`BARE_VALUE`) ended the value at the first
//    `]` and the rest of the secret survived:
//
//      safeErrorDto(new Error(`credentials=[[redacted],"<S>"]`), "p").errorSummary
//        pre-fix:  credentials=[redacted]],"<S>"]
//        post-fix: credentials=[redacted]
//      safeErrorDto(new Error(`password=[[redacted],"<S>"]`), "p").errorSummary
//        pre-fix:  password=[redacted]],"<S>"]
//        post-fix: password=[redacted]
//
//    The reviewer reproduced it end-to-end through propose -> trial -> measure ->
//    archive -> promote and found the secret in the evidence sidecar and the
//    promotion journal. The guard is gone, not moved: it bought nothing. A second
//    projection over an already-redacted value is a no-op because re-redaction is
//    idempotent, which the tests below assert as exact strings rather than assume.
//
// 2. AN ARRAY PROXY MADE `safeErrorEvidence()` THROW.
//    The array branch guarded `slice()` and then called `items.map(...)` outside
//    any guard, so a Proxy whose own `slice` returns a non-array (e.g. `{}`)
//    produced `TypeError: items.map is not a function` out of a boundary
//    documented as non-throwing. The traversal now fails closed to `[compacted]`
//    for that node and withholds a single unreadable element on its own, so the
//    readable siblings of the same record survive.
//
// Every assertion here is behavioural: the observable surfaces are the summary
// `safeErrorDto` produces and the proof projection `snapshotEvidenceFromRecord`
// writes into the evidence sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';

import { safeErrorDto, snapshotEvidenceFromRecord } from '../lib/orchestrator.js';

const SECRET = 'Q7v9SecondPassSecret3';

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

/** The projection a proof gets before it reaches the evidence sidecar. */
function cleanupProofOf(proof) {
  return snapshotEvidenceFromRecord({ cleanupProof: proof }).cleanupProof;
}

// ---------------------------------------------------------------------------
// 1. The container branch claims a value that itself starts with the marker.
// ---------------------------------------------------------------------------

test('a container value that starts with the redaction marker is claimed whole', () => {
  // The two shapes the reviewer reproduced as leaks, at top level.
  const shapes = [
    [`credentials=[[redacted],"${SECRET}"]`, 'credentials=[redacted]'],
    [`password=[[redacted],"${SECRET}"]`, 'password=[redacted]'],
    // The same guard also skipped a `{`-opened value whose body begins with the
    // marker; this form happened to be caught by a sibling branch, so it is
    // pinned here as the control that must not regress.
    [`credentials={"[redacted]","${SECRET}"}`, 'credentials=[redacted]'],
    [`api_key={"[redacted]":"${SECRET}"}`, 'api_key=[redacted]'],
    [`token=["[redacted]","${SECRET}"]`, 'token=[redacted]'],
    // Prose after the container is part of the value, as it is for every other
    // container: the claim runs to the end of the text.
    [`credentials=[[redacted],"${SECRET}"] trailing prose`, 'credentials=[redacted]'],
  ];
  for (const [text, expected] of shapes) {
    const summary = summaryOf(text);
    assert.equal(summary, expected, text);
    assert.equal(summary.includes(SECRET), false, `${text} leaked the secret`);
    assert.equal(summary.includes('SecondPass'), false, `${text} leaked a fragment of the secret`);
  }
});

test('the same container shape nested inside a JSON payload is claimed whole', () => {
  // This is the end-to-end shape the reviewer found in the evidence sidecar and
  // the promotion journal: a JSON document whose credential field carries the
  // marker inside a container.
  const shapes = [
    [`payload={"credentials":[[redacted],"${SECRET}"]}`, 'payload={"credentials":[redacted]'],
    [`payload={"nested":{"credentials":[[redacted],"${SECRET}"]}}`, 'payload={"nested":{"credentials":[redacted]'],
    [`payload={"a":1,"credentials":[[redacted],"${SECRET}"],"retry":3}`, 'payload={"a":1,"credentials":[redacted]'],
  ];
  for (const [text, expected] of shapes) {
    const summary = summaryOf(text);
    assert.equal(summary, expected, text);
    assert.equal(summary.includes(SECRET), false, `${text} leaked the secret`);
  }
});

// ---------------------------------------------------------------------------
// 2. Idempotence: re-redacting a marker value changes nothing, byte for byte.
// ---------------------------------------------------------------------------

test('projecting an already-redacted value once and twice changes nothing', () => {
  // The values a projection produces are fixed points: they must come back
  // byte-identical after one pass and after two. This is the property the deleted
  // guard claimed to provide; it is a property of the rules, not of the guard, and
  // it is asserted rather than assumed.
  const fixedPoints = [
    'password=[redacted]',
    'credentials=[redacted]',
    'api_key=[redacted]',
    '{"credentials":[redacted]',
    '{"password":[redacted]',
    '[redacted]',
  ];
  for (const value of fixedPoints) {
    const once = summaryOf(value);
    const twice = summaryOf(once);
    assert.equal(once, value, `${value} is not stable after one projection`);
    assert.equal(twice, value, `${value} is not stable after two projections`);
    assert.equal(once.length, value.length, `${value} gained or lost characters on the first pass`);
    assert.equal(twice.length, value.length, `${value} gained or lost characters on the second pass`);
  }

  // And the leak shape itself is stable once it has been redacted, which is the
  // property the deleted guard was supposed to provide.
  const redactedOnce = summaryOf(`credentials=[[redacted],"${SECRET}"]`);
  assert.equal(redactedOnce, 'credentials=[redacted]');
  assert.equal(summaryOf(redactedOnce), 'credentials=[redacted]');
});

// ---------------------------------------------------------------------------
// 3. The accepted whole-remainder cost is unchanged and stays exactly as documented.
// ---------------------------------------------------------------------------

test('the accepted cost of the whole-remainder value is exactly this, and is documented', () => {
  // After a credential key and its separator the rest of the text is the value, so
  // the rest of the enclosing document goes with it. This is the cost RELEASE.md
  // §6.29 (p) and §7 record. Round 7 generalised it from containers to every
  // value, and it is asserted here for that reason.
  assert.equal(summaryOf('{"password":{"a":1},"retry":3}'), '{"password":[redacted]');
  // The marker inside a JSON document is the same value, so it pays the same cost:
  // it loses the siblings that follow it. A caller who wants a fixed point has it
  // once the projection has collapsed, as the idempotence test above asserts.
  assert.equal(summaryOf('{"password":[redacted],"retry":3}'), '{"password":[redacted]');
  assert.equal(summaryOf('{"password":[redacted]'), '{"password":[redacted]');
  // A marker that *is* the whole value, with a trailing structural character, is a
  // fixed point after one pass: the marker plus the trailing character is the
  // value, and the replacement is the prefix plus the marker. There is no branch
  // to skip and no structural end to fall through to.
  assert.equal(summaryOf('password=[redacted]'), 'password=[redacted]');
  assert.equal(summaryOf('password=[redacted]]'), 'password=[redacted]');
  // A quoted scalar pays the same cost as of round 7: the closing quote, the comma
  // and the sibling field are gone, and the fragment no longer parses. This is the
  // accepted loss, pinned rather than left unasserted.
  assert.equal(summaryOf('{"password":"x","retry":3}'), '{"password":[redacted]');
  assert.throws(() => JSON.parse(summaryOf('{"password":"x","retry":3}')), SyntaxError,
    'the accepted cost: the fragment is not a JSON document');
});

// ---------------------------------------------------------------------------
// 4. An array Proxy fails closed instead of throwing out of the boundary.
// ---------------------------------------------------------------------------

test('an array Proxy whose slice returns a non-array is withheld, not rethrown', () => {
  // `Array.isArray` is true and `slice` is callable, so both earlier guards
  // passed; `items.map` then threw `TypeError: items.map is not a function`.
  const nonArraySlice = new Proxy([1, 2, 3], {
    get(target, key, receiver) {
      if (key === 'slice') return () => ({});
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(Array.isArray(nonArraySlice), true, 'the shape that broke the old guard');
  assert.doesNotThrow(() => cleanupProofOf(nonArraySlice));
  assert.equal(cleanupProofOf(nonArraySlice), '[compacted]');

  // An array-shaped result whose `length` cannot be read fails the same way.
  const lyingLength = new Proxy([1, 2, 3], {
    get(target, key, receiver) {
      if (key === 'slice') return () => ({ length: 3 });
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(cleanupProofOf(lyingLength), '[compacted]');

  const throwingLength = new Proxy(['a', 'b'], {
    get(target, key, receiver) {
      if (key === 'slice') return () => new Proxy(['a', 'b'], { get(t, k, r) { if (k === 'length') throw new TypeError('length exploded'); return Reflect.get(t, k, r); } });
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(cleanupProofOf(throwingLength), '[compacted]');

  // A `length` the source can return without throwing is coerced a second time
  // by the loop comparison, so the type check has to happen inside the guard.
  // Before it did, this returned `TypeError: Cannot convert a Symbol value to a
  // number` out of a boundary documented as non-throwing.
  const symbolLength = new Proxy([1, 2, 3], {
    get(target, key, receiver) {
      if (key === 'slice') return () => new Proxy([], { get(t, k, r) { return k === 'length' ? Symbol('bad') : Reflect.get(t, k, r); } });
      return Reflect.get(target, key, receiver);
    },
  });
  assert.doesNotThrow(() => cleanupProofOf(symbolLength));
  assert.equal(cleanupProofOf(symbolLength), '[compacted]');

  for (const lying of ['3', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    { valueOf() { throw new Error('coerce'); } }]) {
    const shaped = new Proxy([1, 2, 3], {
      get(target, key, receiver) {
        if (key === 'slice') return () => ({ length: lying });
        return Reflect.get(target, key, receiver);
      },
    });
    assert.doesNotThrow(() => cleanupProofOf(shaped));
    assert.equal(cleanupProofOf(shaped), '[compacted]', `length ${String(lying)} must be withheld`);
  }

  // A real sparse array keeps `map`'s hole semantics: a hole survives as a hole,
  // which JSON renders as `null`, so the guarded loop is not a shape change.
  const sparse = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'slice') return () => { const source = []; source[1] = 'b'; return source; };
      return Reflect.get(target, key, receiver);
    },
  });
  const sparseResult = cleanupProofOf(sparse);
  assert.equal(0 in sparseResult, false, 'a hole stays a hole, as `map` leaves it');
  assert.equal(sparseResult[1], 'b');
  assert.equal(JSON.stringify(sparseResult), '[null,"b"]');
});

test('one unreadable element is withheld on its own, so readable siblings survive', () => {
  // The array node fails closed, and the fields of the record that contains it
  // stay readable: the guard wraps the traversal of one node, not the record.
  const record = cleanupProofOf({ status: 'failed', errors: new Proxy([], { get(t, k) { if (k === 'slice') return () => ({}); return Reflect.get(t, k); } }), stopOk: true });
  assert.deepEqual(record, { status: 'failed', errors: '[compacted]', stopOk: true });

  // Inside the array, an element whose index read throws is withheld while the
  // elements around it are projected normally.
  const partial = new Proxy(['ok', 'boom', 'ok2'], {
    get(target, key, receiver) {
      if (key !== 'slice') return Reflect.get(target, key, receiver);
      return () => new Proxy(['ok', 'boom', 'ok2'], {
        get(t, k, r) { if (k === '1') throw new TypeError('index exploded'); return Reflect.get(t, k, r); },
      });
    },
  });
  assert.deepEqual(cleanupProofOf(partial), ['ok', '[compacted]', 'ok2']);

  // An ordinary array is untouched by the guards.
  assert.deepEqual(cleanupProofOf({ errors: ['timeout', { note: 'x' }] }), { errors: ['timeout', { note: 'x' }] });
  assert.deepEqual(cleanupProofOf([1, 2, 3]), [1, 2, 3]);
});
