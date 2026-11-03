// The autonomous loop's decision reservation must not outlive the process that
// took it.
//
// `reserveAutonomousDecision` is durable and is taken before a Trial touches the
// runner, so a process that ends between the reservation and the owner's answer -
// a crash, or a plain shutdown while a `measured` candidate still waits - leaves
// a reservation with no record behind it. Nothing could resolve that record:
// promotion needs a live in-process experiment (`requireOwned`), and a cleanup
// needs a record to revert. Every later session therefore answered the hypothesis
// with `prior-decision-requires-owner`, pointing at a decision nobody could make,
// and the hypothesis stayed retired for the rest of the durable reservation
// window (the port keeps the newest 200, so in practice forever).
//
// Before the fix the cross-process case below printed, for both later sessions,
// exactly `candidate-awaiting-confirmation / prior-decision-requires-owner` with
// no experiment created:
//
//   S1 seeded: true inherited: 0
//   S2 inherited: 0 phases: ['pattern-observing/-/no-recovery',
//                            'candidate-awaiting-confirmation/prior-decision-requires-owner/no-recovery']
//   S3 inherited: 0 phases: ['candidate-awaiting-confirmation/prior-decision-requires-owner']
//   experiments: []
//
// After it, the first session that observes the same fault releases the inherited
// reservation, takes it for itself and runs one isolated Trial to a measured
// candidate, and reports the release instead of hiding it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

import { openDomainStorage } from '../lib/domain-storage.js';
import { apply } from '../lib/registration.js';
import { context } from './fixtures/runtime-inspect.mjs';

const SESSION = fileURLToPath(new URL('./fixtures/autonomous-decision-session.mjs', import.meta.url));

const improved = {
  solvesProblem: true,
  sideEffects: [],
  orphanResources: [],
  performanceChange: 'decreased',
  errorChange: 'decreased',
  metrics: { errCount: 0 },
  beforeMetrics: { errCount: 1 },
  afterMetrics: { errCount: 0 },
  observationWindow: '1h',
  sampleCount: 2,
  benefitEvidence: 'error count fell from 1 to 0 over the window',
  repeatable: true,
  regressionPassed: true,
  reversible: true,
  cleanupEvidence: 'trial stopped and undefined; runtime fingerprint restored',
};

function declaration(variant = 'a') {
  return {
    risk: 'low',
    target: `plugin:fix-${variant}`,
    idPrefix: `fix${variant}`,
    composition: { name: `fix-${variant}`, purpose: 'narrow the failing path', code: { host: `return { variant: "${variant}" };` } },
    measure: async () => improved,
  };
}

const INPUT = { type: 'agent/error', code: 'AGENT_ERROR', message: 'provider call failed' };

async function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-decision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** One session in this process, on a real official domain store. */
async function session(t, root, { rounds = 0, threshold = 2, reserve = false, variant = 'a' } = {}) {
  const strategy = declaration(variant);
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = {
    ...context(),
    emit() {},
    effect() {},
    logger: { warn() {} },
    storage: { backend: { get: () => backend } },
    dynamicCordisRunner: {
      snapshot: () => [],
      define: () => ({ pluginId: `decision-plugin-${process.pid}-${variant}`, packageId: `decision-package-${process.pid}-${variant}` }),
      run: async () => ({ ok: true, status: 'active' }),
      stop: async () => ({ ok: true }),
      undefine: async () => ({ ok: true }),
    },
    systemPrompt: { section() {} },
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = {
    presetDir: root,
    startupDrift: false,
    eventBridgePath: path.join(root, 'events.jsonl'),
    eventBridgeKey: 'b'.repeat(64),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
    patternThreshold: threshold,
    mode: 'autonomous',
    unattended: true,
    autonomousStrategies: { AGENT_ERROR: strategy },
  };
  const port = await openDomainStorage(ctx, config);
  const core = apply(ctx, { ...config, domainStorage: port });
  const exec = { agent: { id: 'decision-owner' }, signal: new AbortController().signal };
  const identity = `${core.patternKey(INPUT)}:${core.strategyFingerprint(strategy)}`;
  t.after(async () => { await port.close(); await backend.close(); });
  if (reserve) await port.reserveAutonomousDecision(identity);
  const observed = [];
  for (let round = 0; round < rounds; round += 1) observed.push(await core.observeAutonomous(INPUT, exec));
  return { core, port, identity, observed };
}

function runSessionProcess(root, settings) {
  const child = spawnSync(process.execPath, [SESSION, JSON.stringify({ root, ...settings })], { encoding: 'utf8' });
  assert.equal(child.status, 0, `decision session failed: ${child.stderr}`);
  const output = child.stdout.trim().split('\n').filter(Boolean).at(-1);
  assert.ok(output, 'the session printed a summary');
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// A reservation whose process is gone is released, not memorialised
// ---------------------------------------------------------------------------

test('an inherited decision is released and re-trialed instead of refusing the hypothesis forever', async (t) => {
  const root = await scratch(t);

  // The state a process leaves behind when it took the decision and ended before
  // its Trial ran: the reservation is durable, no experiment exists.
  const seeded = runSessionProcess(root, { seed: true, rounds: 0 });
  assert.equal(seeded.seeded, true, 'the first session took the reservation');
  assert.deepEqual(seeded.experiments, [], 'nothing was trialed, so no record can answer for it');

  // A real restart: different pid, so the first session's target claim is proved
  // gone through `process.kill(pid, 0)` rather than assumed dead.
  const second = runSessionProcess(root, { rounds: 2 });
  assert.notEqual(second.pid, seeded.pid);
  assert.deepEqual(second.inherited, [seeded.identity], 'the restart sees the reservation it inherited');
  assert.deepEqual(second.phases.map(entry => entry.phase), ['pattern-observing', 'candidate-awaiting-confirmation']);
  assert.equal(second.phases[1].reason, null, 'the hypothesis is no longer refused with a decision nobody can make');
  assert.equal(second.phases[1].decisionRecovery.reason, 'previous-session-decision', 'the release is reported, not silent');
  assert.equal(second.phases[1].gates.eligible, true, 'the Trial it ran is a normal Trial with normal evidence');
  assert.deepEqual(second.experiments.map(record => record.state), ['measured'], 'one real Trial reached a measured candidate');

  // The hypothesis is re-armed, not retired: the second session's Trial did not
  // survive the restart either, so the next session inherits its reservation and
  // resolves it the same way. Each session still runs exactly one Trial - the
  // rest of its observations report the candidate that Trial measured - so the
  // release cannot turn into a retry loop.
  const third = runSessionProcess(root, { rounds: 3 });
  assert.deepEqual(third.inherited, [seeded.identity], 'the third session inherited the decision the second one took');
  assert.equal(third.phases[0].phase, 'candidate-awaiting-confirmation');
  assert.equal(third.phases[0].decisionRecovery.reason, 'previous-session-decision');
  assert.deepEqual(third.phases.slice(1).map(entry => entry.reason),
    ['already-measured-awaiting-owner', 'already-measured-awaiting-owner'],
    'one Trial per session: later observations report the same candidate');
  assert.equal(new Set(third.phases.slice(1).map(entry => entry.experimentId)).size, 1);
  assert.equal(third.suppressed, 0, 'nothing this hypothesis did is recorded as a failure');
});

// ---------------------------------------------------------------------------
// The two guards: a live record, and a decision this session took
// ---------------------------------------------------------------------------

test('a decision a live record still answers for is never released', async (t) => {
  const root = await scratch(t);
  const { core, port, identity, observed } = await session(t, root, { rounds: 2 });
  assert.equal(observed[1].phase, 'candidate-awaiting-confirmation');
  assert.equal(core.experiments.get(observed[1].experimentId).state, 'measured');

  // The measured candidate waits for its owner, which is exactly the state the
  // reservation exists to protect: a second Trial would mutate the runtime again
  // and fight over the target claim it already owns.
  assert.equal(await core.releaseInheritedAutonomousDecision(identity), null,
    'a record in this process answers for the identity, so the decision is live');
  assert.equal((await port.autonomousDecisions()).includes(identity), false,
    'and it is not even inherited: this session took it');
});

test('a reservation this session took is not treated as inherited', async (t) => {
  const root = await scratch(t);
  // Seeded through the same session that then observes, so it is in the store
  // before the first observation but not in the snapshot the port opened on.
  const { observed, identity, core } = await session(t, root, { rounds: 2, reserve: true });
  assert.equal(observed[0].phase, 'pattern-observing');
  assert.equal(observed[1].phase, 'candidate-awaiting-confirmation');
  assert.equal(observed[1].reason, 'prior-decision-requires-owner', 'a session-owned decision is still honoured');
  assert.equal(observed[1].decisionRecovery, undefined, 'and nothing was released');
  assert.equal(core.experiments.size, 0, 'no Trial was started');
  assert.ok(identity.length > 0);
});
