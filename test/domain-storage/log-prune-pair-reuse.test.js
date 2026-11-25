// `planLogPrune()` reuses the envelopes it already parsed and authenticated in
// its verification pass to build the floor's `prunable` pairs, instead of
// decoding and parsing each discarded line a second time. The plan is identical
// for every input shape; this file pins that with a reverse transformation to
// the released double-parse implementation and a mutation that proves the
// comparison has teeth.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { planLogPrune } from '../../lib/event-log-checkpoint.js';

const KEY = 'b'.repeat(64);
const WRITER = 'dsh-evolution-orchestrator';
const SOURCE = fs.readFileSync(new URL('../../lib/event-log-checkpoint.js', import.meta.url), 'utf8');

// The exact block as it now stands (POST) and the released double-parse block
// (PRE). A single-occurrence replace fails on any shape drift rather than
// silently reconstructing a different implementation.
const POST = `  const maxBoundary = Math.max(0, ranges.length - keep);
  const absorbedPairs = [];
  let absorbed = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const line = buffer.subarray(range.start, range.end - 1).toString('utf8');
    if (!line.trim()) { absorbed += 1; continue; }
    let envelope;
    try { envelope = JSON.parse(line); } catch { break; }
    const verified = verifyEventBridgeEnvelope(envelope, key);
    if (!verified || verified.writer !== writer) break;
    const eventId = verified.event?.eventId;
    if (typeof eventId !== 'string' || !Object.hasOwn(applied, eventId)) break;
    if (applied[eventId] !== envelope.mac) break;
    if (index < maxBoundary) absorbedPairs[index] = { eventId, mac: envelope.mac };
    absorbed += 1;
  }
  const boundary = Math.min(absorbed, maxBoundary);
  if (boundary <= 0) return null;
  const prefixBytes = ranges[boundary - 1].end;
  const pairs = [];
  for (let index = 0; index < boundary; index += 1) {
    if (absorbedPairs[index]) pairs.push(absorbedPairs[index]);
  }`;

const PRE = `  let absorbed = 0;
  for (const range of ranges) {
    const line = buffer.subarray(range.start, range.end - 1).toString('utf8');
    if (!line.trim()) { absorbed += 1; continue; }
    let envelope;
    try { envelope = JSON.parse(line); } catch { break; }
    const verified = verifyEventBridgeEnvelope(envelope, key);
    if (!verified || verified.writer !== writer) break;
    const eventId = verified.event?.eventId;
    if (typeof eventId !== 'string' || !Object.hasOwn(applied, eventId)) break;
    if (applied[eventId] !== envelope.mac) break;
    absorbed += 1;
  }
  const boundary = Math.min(absorbed, Math.max(0, ranges.length - keep));
  if (boundary <= 0) return null;
  const prefixBytes = ranges[boundary - 1].end;
  const pairs = [];
  for (let index = 0; index < boundary; index += 1) {
    const line = buffer.subarray(ranges[index].start, ranges[index].end - 1).toString('utf8');
    if (!line.trim()) continue;
    const envelope = JSON.parse(line);
    pairs.push({ eventId: envelope.event.eventId, mac: envelope.mac });
  }`;

// A broken candidate: the reused pair carries a stale eventId. If the
// differential below cannot see this, its equality assertion is vacuous.
const MUTATED = POST.replace('absorbedPairs[index] = { eventId, mac: envelope.mac }',
  "absorbedPairs[index] = { eventId: 'corrupted-' + index, mac: envelope.mac }");

function count(text, fragment) {
  let n = 0;
  let at = text.indexOf(fragment);
  while (at !== -1) { n += 1; at = text.indexOf(fragment, at + fragment.length); }
  return n;
}

const orchestratorUrl = pathToFileURL(new URL('../../lib/orchestrator.js', import.meta.url).pathname).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-prune-reuse-'));
process.once('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));

async function variantModule(label, block) {
  assert.equal(count(SOURCE, POST), 1, 'candidate block must appear exactly once in production source');
  const source = SOURCE.replace(POST, block).replace("from './orchestrator.js'", `from '${orchestratorUrl}'`);
  const file = path.join(tempRoot, `event-log-checkpoint-${label}.mjs`);
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

function fixture(count, { blanks = false, unabsorbed = 0, torn = false } = {}) {
  const applied = {};
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const eventId = `evt-${String(index).padStart(8, '0')}`;
    const envelope = signEventBridgeEnvelope({ eventId, experimentId: 'r13', eventType: 'experiment-rejected' },
      { key: KEY, writer: WRITER, sequence: index + 1 });
    applied[eventId] = envelope.mac;
    lines.push(JSON.stringify(envelope));
    if (blanks && index % 17 === 0) lines.push('');
  }
  for (let index = 0; index < unabsorbed; index += 1) {
    const eventId = `new-${String(index).padStart(8, '0')}`;
    const envelope = signEventBridgeEnvelope({ eventId, experimentId: 'r13', eventType: 'experiment-rejected' },
      { key: KEY, writer: WRITER, sequence: count + index + 1 });
    // Deliberately absent from `applied` so the verification pass breaks here.
    lines.push(JSON.stringify(envelope));
  }
  let buffer = Buffer.from(lines.join('\n') + '\n', 'utf8');
  // Cut into the final record so the unterminated tail is an unparsable
  // fragment (a whole envelope without its LF is still reclaimable).
  if (torn) buffer = buffer.subarray(0, buffer.length - 12);
  return { buffer, applied };
}

function planProjection(plan) {
  if (plan === null) return null;
  const { prunable, ...rest } = plan;
  return { ...rest, prunable: prunable.map(pair => ({ ...pair })) };
}

const CASES = [
  { name: 'all-absorbed-2k', count: 2000, keep: 1 },
  { name: 'all-absorbed-2k-blanks', count: 2000, keep: 1, blanks: true },
  { name: 'keep-500', count: 3000, keep: 500 },
  { name: 'unabsorbed-tail', count: 3000, keep: 1, unabsorbed: 5 },
  { name: 'unabsorbed-tail-blanks', count: 3000, keep: 1, unabsorbed: 5, blanks: true },
];

test('planLogPrune is byte-identical to the released double-parse implementation', async () => {
  const baseline = await variantModule('baseline', PRE);
  for (const sample of CASES) {
    const { buffer, applied } = fixture(sample.count, sample);
    const identity = { dev: '1', ino: '2' };
    const a = planProjection(baseline.planLogPrune({ buffer, key: KEY, writer: WRITER, applied,
      retainRecords: sample.keep, identity }));
    const b = planProjection(planLogPrune({ buffer, key: KEY, writer: WRITER, applied,
      retainRecords: sample.keep, identity }));
    assert.deepEqual(b, a, `${sample.name}: plan differs from released implementation`);
    if (a !== null) assert.ok(a.prunable.length > 0, `${sample.name}: fixture must prune something`);
  }
});

test('the reuse removes exactly one JSON.parse per pruned record (call-count counter-example)', async () => {
  const baseline = await variantModule('baseline-count', PRE);
  const { buffer, applied } = fixture(2000, { keep: 1 });
  const identity = { dev: '1', ino: '2' };
  const args = { buffer, key: KEY, writer: WRITER, applied, retainRecords: 1, identity };
  const native = JSON.parse;
  let calls = 0;
  JSON.parse = (...rest) => { calls += 1; return native(...rest); };
  try {
    baseline.planLogPrune(args);
    const baselineCalls = calls;
    calls = 0;
    const plan = planLogPrune(args);
    const candidateCalls = calls;
    assert.ok(plan !== null && plan.prunable.length > 0);
    assert.equal(baselineCalls - candidateCalls, plan.prunable.length,
      'the candidate must parse each pruned line once instead of twice');
  } finally { JSON.parse = native; }
});

test('the differential rejects a broken reuse (mutation counter-example)', async () => {
  const mutated = await variantModule('mutated', MUTATED);
  const { buffer, applied } = fixture(2000, { keep: 1 });
  const identity = { dev: '1', ino: '2' };
  const good = planProjection(planLogPrune({ buffer, key: KEY, writer: WRITER, applied, retainRecords: 1, identity }));
  const bad = planProjection(mutated.planLogPrune({ buffer, key: KEY, writer: WRITER, applied, retainRecords: 1, identity }));
  assert.notDeepEqual(bad, good, 'a stale reused eventId must be caught by the differential');
  assert.equal(bad.prunable[0].eventId, 'corrupted-0');
});

test('torn tail still refuses before any pair reuse is published', async () => {
  const baseline = await variantModule('baseline-torn', PRE);
  const { buffer, applied } = fixture(2000, { keep: 1, torn: true });
  for (const impl of [baseline.planLogPrune, planLogPrune]) {
    assert.throws(() => impl({ buffer, key: KEY, writer: WRITER, applied, retainRecords: 1 }),
      (error) => error?.code === 'E_DOMAIN_EVENT_LOG_PARTIAL_TAIL');
  }
});

test('key/writer identity is still enforced (no reuse across a writer or key mismatch)', async () => {
  const { buffer, applied } = fixture(1000, { keep: 1 });
  // A different writer breaks the verification pass in both implementations,
  // so no pairs are reused and no floor is produced.
  assert.equal(planLogPrune({ buffer, key: KEY, writer: 'another-writer', applied, retainRecords: 1 }), null);
  const tampered = Buffer.from(buffer);
  tampered[tampered.indexOf(0x0a) - 1] ^= 0x01; // change one byte in the first record's MAC
  assert.equal(planLogPrune({ buffer: tampered, key: KEY, writer: WRITER, applied, retainRecords: 1 }), null);
});
