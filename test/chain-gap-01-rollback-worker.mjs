// Crash-injection worker for chain-gap-01-rollback-recovery.test.mjs.
//
// It drives the real canary-regression lifecycle on an isolated os.tmpdir()
// data root and kills itself at the exact window the gap describes: after
// rollbackPromotionJournal() returned (journal removed) and before archive()
// or publishConclusion() could write a terminal fact. No production code is
// patched; only the orchestrator instance in this child has its archive call
// replaced by the crash.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [root, experimentId] = process.argv.slice(2);
const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (name) => import(pathToFileURL(path.join(base, 'lib', name)).href);
const { EvolutionOrchestrator } = await load('orchestrator.js');
const { openSharedExperience } = await load('shared-experience.js');
const {
  promotionPaths, orchestratorContext, unitPromotionRuntime, execFor,
} = await import(pathToFileURL(path.join(base, 'test', 'orchestrator-durability-fixtures.mjs')).href);

const paths = promotionPaths(root);
paths.promotionRuntime = unitPromotionRuntime();
const store = openSharedExperience(path.join(root, 'shared-experience'));
const core = new EvolutionOrchestrator(orchestratorContext(), {
  ...paths,
  startupDrift: false,
  sharedExperience: store,
  eventBridge: { emit: () => ({}) },
});
core.experiments.set(experimentId, {
  id: experimentId,
  ownerId: 'durability-owner',
  state: 'canary-observing',
  targets: [],
  proposal: {
    owner: 'durability-owner', why: 'rollback crash window', target: 'tool:chain-gap-01',
    strategy: 'prewarm the cache before the first read', applicability: { dsh: '0.2.23', cordis: '4.1.0', evolution: '0.2.23' },
    impactScope: ['isolated-test'], successMetrics: ['regression recorded'],
  },
  observations: [],
  latestObservation: {},
  canary: { healthObservationWindow: 2, observations: [], startupVerified: false },
});
core.archive = async () => {
  await fs.writeFile(path.join(root, 'crash-marker'), 'after-rollback-before-archive\n');
  process.kill(process.pid, 'SIGKILL');
};
await core.observeCanary({
  experimentId,
  metricRegression: true,
  barrier: { id: 'window:regression', reached: true },
  startupVerified: true,
  componentHealth: 'active',
  dependenciesPresent: true,
}, execFor());
process.stdout.write('UNEXPECTED-SUCCESS\n');
