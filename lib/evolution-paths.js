/**
 * Host-free path resolution shared by the kernel, the doctor and the
 * lightweight experience entry. Mirrors lib/index.js storageConfig without
 * creating anything, so every reader resolves the same data root.
 */
import os from 'node:os';
import path from 'node:path';

// Path resolution (host-free; mirrors lib/index.js storageConfig without
// creating anything)
// ---------------------------------------------------------------------------

export function resolveEvolutionPaths({ dshHome, dataRoot } = {}) {
  const home = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const root = path.resolve(dataRoot || path.join(home, 'storages', 'evolution'));
  return {
    dshHome: home,
    dataRoot: root,
    presetDir: root,
    presetId: 'evolution',
    keyPath: path.join(root, 'event-bridge.key'),
    pluginRoot: path.join(root, 'promoted'),
    compositionPath: path.join(root, 'promoted.cordis.yml'),
    evolutionPath: path.join(root, 'EVOLUTION.md'),
    archiveDir: path.join(root, 'archive', 'experiments'),
    promotionStateDir: path.join(root, 'promotion'),
    promotionLockPath: path.join(root, 'promotion.lock'),
    memoryPath: path.join(root, 'evolution-memory.json'),
    eventBridgePath: path.join(root, 'execution-events.jsonl'),
    driftStatePath: path.join(root, 'official-runtime-baseline.json'),
    ownershipDir: path.join(root, 'ownership'),
    dockyardDir: path.join(root, 'dockyard'),
    domainStagingDir: path.join(root, 'domain-staging'),
    domainArchiveLockPath: path.join(root, 'domain-archive.lock'),
    migrationManifestPath: path.join(root, 'migration-manifest.json'),
    domainGlobalPath: path.join(home, 'storages', 'evolution_domain.json'),
  };
}
