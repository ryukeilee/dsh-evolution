import { Service } from '@deepseek-ai/cordis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { apply as registerOrchestrator } from './registration.js';
import { mountPromotedInclude } from './promotion-include.js';
import { recoverInterruptedPromotion } from './orchestrator.js';
import { openDomainStorage } from './domain-storage.js';

export const name = 'dsh-evolution';
export const inject = ['tools', 'dynamicCordisRunner', 'systemPrompt', 'loader', 'storageDomain'];

export function storageConfig(config = {}) {
  const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const dataRoot = path.resolve(config.dataRoot || path.join(home, 'storages', 'evolution'));
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataRoot, 'event-bridge.key');
  try {
    fs.writeFileSync(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const eventBridgeKey = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(eventBridgeKey)) throw new Error('Evolution event bridge key is invalid; refusing to replace it');
  return {
    ...config,
    dshHome: home,
    presetId: 'evolution',
    presetDir: dataRoot,
    pluginRoot: path.join(dataRoot, 'promoted'),
    compositionPath: path.join(dataRoot, 'promoted.cordis.yml'),
    evolutionPath: path.join(dataRoot, 'EVOLUTION.md'),
    archiveDir: path.join(dataRoot, 'archive', 'experiments'),
    promotionStateDir: path.join(dataRoot, 'promotion'),
    promotionLockPath: path.join(dataRoot, 'promotion.lock'),
    memoryPath: path.join(dataRoot, 'evolution-memory.json'),
    eventBridgePath: path.join(dataRoot, 'execution-events.jsonl'),
    eventBridgeKey,
    driftStatePath: path.join(dataRoot, 'official-runtime-baseline.json'),
    ownershipDir: path.join(dataRoot, 'ownership'),
    startupDrift: false,
    promotionAdapter: 'official-include',
  };
}

class EvolutionService extends Service {
  constructor(ctx, orchestrator, config) {
    super(ctx, 'evolution');
    this.orchestrator = orchestrator;
    this.dataRoot = config.presetDir;
  }
}

export async function apply(ctx, config = {}) {
  const resolved = storageConfig(config);
  resolved.domainStorage = await openDomainStorage(ctx, resolved);
  // Recover interrupted disk transactions BEFORE Include loads any children.
  await recoverInterruptedPromotion(resolved);
  resolved.promotionRuntime = await mountPromotedInclude(ctx, resolved);
  // The official runner lazily retains its empty cordis-dynamic host group.
  // Initialize it through PUBLIC define/run/stop/undefine before capturing the
  // first experiment baseline, never by invoking its private ensureGroup().
  let preparation;
  resolved.prepareRuntime = (agent, signal) => {
    if (preparation) return preparation;
    preparation = (async () => {
      const runner = ctx.dynamicCordisRunner;
      const defined = runner.define({ sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'evo' },
        name: 'Evolution runtime preparation', purpose: 'Initialize official shared dynamic host infrastructure before baseline capture',
        code: { host: 'return { name: "evolution-runtime-prepare", apply() {} };' } });
      try {
        const started = await runner.run(agent, defined.pluginId, defined.packageId, 'run', signal);
        if (!started.ok) throw new Error(started.message || 'Evolution runtime preparation failed');
        const stopped = await runner.stop(agent, defined.pluginId);
        if (!stopped.ok) throw new Error('Evolution runtime preparation did not stop');
      } finally {
        const removed = await runner.undefine(agent, defined.pluginId);
        if (!removed.ok) throw new Error('Evolution runtime preparation did not undefine');
      }
    })().catch(error => { preparation = undefined; throw error; });
    return preparation;
  };
  const orchestrator = registerOrchestrator(ctx, resolved);
  new EvolutionService(ctx, orchestrator, resolved);
}
