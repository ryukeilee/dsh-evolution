// Shared fixtures for the orchestrator durability regressions
// (test/orchestrator-durability-*.test.mjs). Synthetic state only: every path
// lives under a fresh os.tmpdir() directory and is removed by the caller.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function scratchRoot(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `evo-durability-${name}-`));
}

export function promotionPaths(root) {
  return {
    presetId: 'durability',
    presetDir: root,
    pluginRoot: path.join(root, 'promoted'),
    compositionPath: path.join(root, 'promoted.cordis.yml'),
    evolutionPath: path.join(root, 'EVOLUTION.md'),
    archiveDir: path.join(root, 'archive'),
    promotionStateDir: path.join(root, 'promotion'),
    promotionLockPath: path.join(root, 'promotion.lock'),
    // Never fall back to the real user data root: the default event bridge
    // path lives under os.homedir().
    eventBridgePath: path.join(root, 'evolution-events.jsonl'),
    eventBridgeKey: 'd'.repeat(64),
  };
}

/** Unit-level promotion adapter: the real official Include is only mounted by
 *  the tests that need to observe its lifecycle. */
export function unitPromotionRuntime() {
  return {
    parse: JSON.parse,
    stringify: (rows) => JSON.stringify(rows),
    refresh: async () => {},
    verify: async () => ({ officialInclude: true, active: true }),
    health: async () => ({ componentHealth: 'active', dependenciesPresent: true }),
  };
}

export function promotionExperiment(id, owner = 'durability-owner') {
  return {
    id,
    ownerId: owner,
    state: 'promoting',
    proposal: { owner, why: 'durability regression', target: 'plugin:durability', impactScope: ['test'], successMetrics: ['durability'], createdAt: '2026-01-01T00:00:00.000Z' },
    runtimeRecovered: true,
    observations: [],
    latestObservation: {},
  };
}

export const HOST_CODE = 'return { name: "durability", apply() {} };';

/** Minimal cordis-shaped context for EvolutionOrchestrator without a host. */
export function orchestratorContext(warnings = []) {
  return {
    registry: { values: () => [] },
    reflect: { props: {}, _getImpl: () => undefined },
    events: { _hooks: {} },
    tools: { schemas: () => [], register() {} },
    dynamicCordisRunner: { snapshot: () => [] },
    get: () => ({ list: () => [] }),
    logger: {
      debug() {},
      error() {},
      warn: (...args) => warnings.push(args.map(String).join(' ')),
    },
  };
}

export function execFor(agentId = 'durability-owner') {
  return { agent: { id: agentId }, signal: new AbortController().signal };
}

export async function writeJournal(paths, journal) {
  const file = path.join(paths.promotionStateDir, 'journal.json');
  await fs.mkdir(paths.promotionStateDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(journal, null, 2)}\n`);
  return file;
}

export async function readJournal(paths) {
  return JSON.parse(await fs.readFile(path.join(paths.promotionStateDir, 'journal.json'), 'utf8'));
}

export async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}
