import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signEventBridgeEnvelope, verifyEventBridgeEnvelope } from '../lib/orchestrator.js';

// Frozen pre-optimization encoder: compare MAC bytes, not merely a round trip
// through two callers sharing the same potentially incompatible encoder.
function legacy(value) {
  if (Array.isArray(value)) return `[${value.map(legacy).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${legacy(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const key = 'synthetic-canonical-test-key-0123456789';
function check(event, sequence = 1) {
  const envelope = signEventBridgeEnvelope(event, { key, sequence });
  const payload = { schema: 2, writer: envelope.writer, sequence, event };
  const mac = crypto.createHmac('sha256', key).update(legacy(payload)).digest('hex');
  assert.equal(envelope.mac, mac);
  assert.equal(verifyEventBridgeEnvelope({ ...envelope, mac }, key)?.event, event);
  assert.equal(verifyEventBridgeEnvelope({ ...envelope, event: { ...event, tampered: true } }, key), null);
}

test('canonical bridge MAC retains legacy key order, escaping and array semantics', () => {
  const unusual = JSON.parse('{"__proto__":{"polluted":true},"10":"ten","2":"two","":"empty"}');
  check({ unusual, 'quote"\\\n': '中文\u2028\ud800', values: [null, true, false, -0, 1e30, NaN, Infinity], empty: {}, array: [] });
  check({ values: [undefined, , () => {}, { omitted: undefined }], date: new Date(0) });
  assert.equal({}.polluted, undefined);
});

test('canonical bridge MAC remains compatible after bounded key cache saturation', () => {
  // Fixed pseudo-random nested JSON; exercise long and adversarial key names
  // beyond the cache limit, plus repeat keys after it has filled.
  let seed = 42;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 400; i++) {
    const event = { eventId: `event-${i}`, measurement: { latency: random() / 1000 } };
    event[`key-${i}-"\\`] = [{ ['long'.repeat(40)]: random(), nested: [random(), '中文', null] }];
    check(event, i + 1);
  }
  check({ eventId: 'final', measurement: { latency: 10 } });
});
