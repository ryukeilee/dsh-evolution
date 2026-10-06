import { test, assert, summary, registerCleanup } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-bridge-auth-'));
registerCleanup(scratch);
const bridgePath = path.join(scratch, 'events.jsonl');
const key = 'isolated-test-event-bridge-key-0123456789';
const event = { eventId: 'evolution:promotion-succeeded:exp-auth', eventType: 'promotion-succeeded', experimentId: 'exp-auth', measurement: { sampleCount: 1 }, evidence: { eligible: true, runtimeRecovered: true }, promotion: { pluginName: 'trusted', promotionTimestamp: '2026-01-01T00:00:00.000Z' }, audit: { at: '2026-01-01T00:00:00.000Z' } };

function write(lines) { fs.writeFileSync(bridgePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n'); }

await test('authenticated bridge accepts legitimate evidence and does not disclose key material', async () => {
  const envelope = mod.signEventBridgeEnvelope(event, { key, sequence: 1 });
  write([envelope]);
  const result = await mod.readEventBridgeEvidence(bridgePath, 'exp-auth', { key });
  assert(result?.runtimeRecovered === true, 'authenticated recovery is trusted');
  assert(!fs.readFileSync(bridgePath, 'utf8').includes(key), 'bridge never stores key');
});

await test('unsigned, tampered, forged promotion and replayed records fail closed', async () => {
  const signed = mod.signEventBridgeEnvelope(event, { key, sequence: 1 });
  const tampered = structuredClone(signed); tampered.event.promotion.pluginName = 'forged';
  const forged = { ...event, eventId: 'evolution:promotion-succeeded:exp-forged', experimentId: 'exp-forged', evidence: { runtimeRecovered: true }, promotion: { pluginName: 'forged' } };
  const untrustedWriter = mod.signEventBridgeEnvelope(forged, { key, writer: 'untrusted-writer', sequence: 2 });
  write([forged, untrustedWriter, tampered, signed, signed, '{malformed']);
  const trusted = await mod.readEventBridgeEvidence(bridgePath, 'exp-auth', { key });
  const rejected = await mod.readEventBridgeEvidence(bridgePath, 'exp-forged', { key });
  assert(trusted?.durable?.pluginName === 'trusted', 'tampering and replay do not replace trusted record');
  assert(rejected === null, 'unsigned or untrusted-writer promotion is rejected');
});

await test('sequence rollback is isolated without poisoning later valid events', async () => {
  const first = mod.signEventBridgeEnvelope({ ...event, experimentId: 'exp-seq', eventType: 'measurement-completed', eventId: 'evolution:measurement-completed:exp-seq' }, { key, sequence: 2 });
  const rollback = mod.signEventBridgeEnvelope({ ...event, experimentId: 'exp-seq', eventId: 'rollback', promotion: { pluginName: 'rollback' } }, { key, sequence: 1 });
  write([first, rollback]);
  const result = await mod.readEventBridgeEvidence(bridgePath, 'exp-seq', { key });
  assert(result?.durable === null, 'out-of-order promotion is rejected');
  assert(result?.latestObservation?.sampleCount === 1, 'valid record remains usable');
});

summary();
