// Synthetic, isolated child-process fixture; never reads a user profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { openDomainStorage } from '../lib/domain-storage.js';
import { EvolutionEventBridge, externalizeEventBridgeEvidence, withEventBridgeAppendLock } from '../lib/orchestrator.js';
export const KEY = 'c'.repeat(64);
export function configFor(root) {
  const archiveDir = path.join(root, 'archive');
  return { presetDir: root, archiveDir, eventBridgePath: path.join(root, 'execution-events.jsonl'),
    eventBridgeKey: KEY, externalizeEventEvidence: rows => externalizeEventBridgeEvidence({ archiveDir }, rows) };
}
export async function openFixture(root, overrides = {}) {
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, effect() {}, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } } };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const port = await openDomainStorage(ctx, { ...configFor(root), ...overrides });
  return { port, global: () => ctx.storageDomain.get('evolution_domain').global.get(),
    close: async () => { await port.close(); await backend.close(); } };
}
export function emit(root, id, type = 'measurement-completed') {
  const bridge = new EvolutionEventBridge({ file: configFor(root).eventBridgePath, key: KEY });
  bridge.emit(type, {}, { experimentId: id, proposalId: id, target: `target-${id}`, capability: `target-${id}`,
    status: type === 'experiment-rejected' ? 'rejected' : 'promoted', measurement: { latencyMs: 12 },
    failureFingerprint: `fingerprint-${id}`, evidence: { runtimeRecovered: true, testsPassed: true, goalPassed: true },
    promotion: { id: `promotion-${id}`, pluginName: `plugin-${id}`, promotionTimestamp: '2026-10-27T00:00:00.000Z' } });
}
if (process.argv[2] === '--worker') {
  const [root, mode, prefix] = process.argv.slice(3);
  try {
    if (mode === 'write') {
      process.send({ ready: true });
      await new Promise(resolve => process.once('message', resolve));
      for (let i = 0; i < 16; i++) {
        for (let attempt = 0; ; attempt++) {
          try { emit(root, `${prefix}-${i}`); break; }
          catch (error) { if (!/lock|busy/i.test(error.message) || attempt >= 39) throw error; await delay(5); }
        }
      }
      process.send({ done: true });
    } else if (mode === 'crash') {
      const f = await openFixture(root);
      const lock = `${configFor(root).eventBridgePath}.append.lock`;
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ token: 'child-crash', pid: process.pid,
        hostname: os.hostname(), acquiredAt: Date.now() }));
      const report = await f.port.reclaim({ confirmation: true, archives: false, retainRecords: 2 });
      process.send({ report, global: f.global() });
      setInterval(() => {}, 1000); // Parent kills without close: durable floor, old log, dead lock.
    } else if (mode === 'probe-lock') {
      withEventBridgeAppendLock(configFor(root).eventBridgePath, () => { throw new Error('unexpected lock acquisition'); });
    } else if (mode === 'recover') {
      const f = await openFixture(root);
      const flush = await f.port.flush();
      const global = f.global();
      await f.close();
      process.send({ flush, global });
    }
    if (mode !== 'crash') process.disconnect();
  } catch (error) { process.send({ error: error.stack }); process.exitCode = 1; process.disconnect(); }
}
