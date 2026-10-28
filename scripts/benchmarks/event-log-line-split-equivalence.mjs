#!/usr/bin/env node
/**
 * Equivalence check for splitting the retained event-log bytes by line.
 *
 * The withdrawn candidate in `event-log-replay-memory-rejected.patch` replaced
 * `tail.toString('utf8').split('\n')` with one decode per line feed boundary.
 * That is only sound if, for arbitrary bytes, splitting at `0x0A` and decoding
 * each segment yields the same strings as decoding the whole buffer and
 * splitting the string - including for bytes that are not valid UTF-8, where the
 * decoder's replacement rules apply to maximal subparts.
 *
 * The argument is that `0x0A` is never a UTF-8 continuation byte, so no
 * multi-byte sequence or invalid maximal subpart can cross a line feed. This
 * script is the empirical pin: crafted sequences that are truncated exactly at a
 * line feed, overlong encodings, surrogate halves, BOM, NUL, and random or
 * biased byte strings (with and without a line feed inserted at every position).
 *
 * Usage:
 *   node scripts/benchmarks/event-log-line-split-equivalence.mjs [--random 4000] [--seed 0]
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    result[value.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return result;
}

/** Split at line feeds without materializing the whole decoded string. */
function splitBytes(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    lines.push(buffer.toString('utf8', start, index));
    start = index + 1;
  }
  lines.push(buffer.toString('utf8', start));
  return lines;
}

const seeds = [
  [0xe2, 0x82],                            // truncated three-byte sequence
  [0xe2, 0x82, 0x0a],                      // ... terminated by a line feed
  [0xf0, 0x9f, 0x92, 0x0a],                // truncated four-byte sequence, then line feed
  [0xc3, 0x28, 0x0a],                      // bad continuation byte
  [0xed, 0xa0, 0x80, 0x0a],                // surrogate half
  [0xc0, 0xaf, 0x0a],                      // overlong encoding
  [0xff, 0xfe, 0x0a],                      // invalid bytes
  [0xef, 0xbb, 0xbf, 0x0a],                // BOM
  [0x00, 0x0a, 0x00],                      // NUL around a line feed
  [0xe2, 0x82, 0xac, 0x0a],                // U+20AC
  [0xf0, 0x9f, 0x98, 0x80, 0x0a],          // U+1F600
  [...Buffer.from('a\n\n\n')],
  [],
];

function casesFor(random, seed) {
  const cases = seeds.map((bytes) => Buffer.from(bytes));
  for (const seedBytes of seeds) {
    for (let index = 0; index < seedBytes.length; index += 1) {
      cases.push(Buffer.concat([Buffer.from(seedBytes.slice(0, index)), Buffer.from([0x0a]), Buffer.from(seedBytes.slice(index))]));
      cases.push(Buffer.from(seedBytes.slice(0, index)));
    }
  }
  // Deterministic pseudo-random bytes, seeded so a failure reproduces.
  let state = seed >>> 0 || 1;
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
  const biased = [0x0a, 0x0a, 0x41, 0x7f, 0x80, 0xbf, 0xc0, 0xc3, 0xe2, 0xed, 0xf0, 0xf4, 0xff];
  for (let index = 0; index < random; index += 1) {
    const length = next() % 40;
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset += 1) bytes[offset] = next() % 256;
    cases.push(bytes);
    const shaped = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset += 1) shaped[offset] = biased[next() % biased.length];
    cases.push(shaped);
  }
  return cases;
}

const options = argsOf(process.argv.slice(2));
const random = Number(options.random ?? 4000);
const seed = Number(options.seed ?? 0);
assert.ok(Number.isSafeInteger(random) && random >= 0, '--random must be a non-negative integer');
assert.ok(Number.isSafeInteger(seed) && seed >= 0, '--seed must be a non-negative integer');
const cases = casesFor(random, seed);
let mismatches = 0;
for (const bytes of cases) {
  const whole = bytes.toString('utf8').split('\n');
  const parts = splitBytes(bytes);
  const same = whole.length === parts.length && whole.every((line, index) => line === parts[index]);
  if (same) continue;
  mismatches += 1;
  if (mismatches <= 3) {
    process.stderr.write(`mismatch for ${JSON.stringify([...bytes])}\n  whole: ${JSON.stringify(whole)}\n  bytes: ${JSON.stringify(parts)}\n`);
  }
}
const digest = crypto.createHash('sha256').update(cases.map((bytes) => bytes.toString('hex')).join('\n')).digest('hex');
process.stdout.write(`${JSON.stringify({ cases: cases.length, mismatches, seed, corpusSha256: digest, ok: mismatches === 0 })}\n`);
if (mismatches > 0) process.exitCode = 1;
