import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { apply as applyClient } from '../lib/desktop-task-client.js';
import { createDesktopTaskHost } from '../lib/desktop-task-host.js';
import { mintTaskId, taskChannelPaths } from '../lib/desktop-task-protocol.js';

const GATES = Object.freeze({
  benefit: true, measured: true, repeatable: true, regression: true,
  reversibility: true, cleanup: true, noOrphans: true, runtimeRecovery: true, eligible: true,
});

function temporary(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-task-integration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition did not settle');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

test('the ACP client and the Desktop host complete one task through the shared channel', async (t) => {
  const home = temporary(t);
  const tool = `integration_stats_${mintTaskId().slice(-8)}`;
  const hostCode = `const tool = harness.defineTool({ name: '${tool}', execute: async ({ text }) => ({ characters: text.length, lines: text.split('\\n').length }) }); return { name: '${tool}', inject: ['tools'], apply(ctx) { harness.registerTool(ctx, tool); } };`;
  const plan = {
    proposal: { why: 'integration', target: `plugin:${tool}`, impactScope: ['test'], successMetrics: ['match'] },
    composition: { name: tool, purpose: 'read-only text statistics', code: { host: hostCode } },
    verification: {
      targetTool: tool,
      observations: 2,
      samples: [
        { label: 'one', tool, arguments: { text: 'abc' }, expected: { characters: 3, lines: 1 } },
        { label: 'two', tool, arguments: { text: 'a\nb' }, expected: { characters: 3, lines: 2 } },
      ],
    },
    requestedTargetProfiles: ['acp'],
  };

  const calls = [];
  let candidateVisible = false;
  let observations = 0;
  const dataRoot = path.join(home, 'storages', 'evolution');
  const kernelTools = new Map();
  kernelTools.set('evolution_runtime_inspect', { execute: async () => ({ components: [], services: [], events: [] }) });
  kernelTools.set('evolution_propose', { execute: async () => ({ ok: true, experimentId: 'exp-integration-1', phase: 'proposed' }) });
  kernelTools.set('evolution_trial', { execute: async () => { calls.push('trial'); candidateVisible = true; return { ok: true, experimentId: 'exp-integration-1', phase: 'trial' }; } });
  kernelTools.set('evolution_measure', { execute: async () => ({ ok: true, phase: 'measured', gates: GATES, decision: { kind: 'benefit', eligible: true } }) });
  kernelTools.set('evolution_promote', { execute: async (args) => {
    calls.push(args.confirmation === true ? 'promote-confirmed' : 'promote-gate');
    return args.confirmation === true
      ? { ok: true, phase: 'canary-observing' }
      : { ok: false, phase: 'awaiting-owner-confirmation', gates: GATES, decision: { kind: 'benefit', eligible: true } };
  } });
  kernelTools.set('evolution_canary_observe', { execute: async () => {
    calls.push('canary');
    observations += 1;
    if (observations >= 2) {
      await fsp.mkdir(path.join(dataRoot, 'archive', 'experiments'), { recursive: true });
      await fsp.writeFile(path.join(dataRoot, 'archive', 'experiments', 'exp-integration-1.evidence.json'), JSON.stringify({
        runtimeRecovered: true,
        recoveryProof: { status: 'recovered' },
        gateEvidence: { gates: GATES },
        publication: { sourceSha256: 'kernel-sha' },
      }));
      await fsp.mkdir(path.join(dataRoot, 'shared-plugins'), { recursive: true });
      await fsp.writeFile(path.join(dataRoot, 'shared-plugins', 'published.json'), JSON.stringify({
        schemaVersion: 1,
        plugins: [{ id: 'evolution-promoted-integration', experimentId: 'exp-integration-1', pluginName: 'dsh-evolution-promoted-integration', sourceSha256: 'kernel-sha', approvedProfiles: ['acp'], publisherProfile: 'desktop', stable: { committedAt: new Date().toISOString() } }],
      }));
    }
    return { stable: observations >= 2 };
  } });
  kernelTools.set('evolution_revert', { execute: async () => { calls.push('revert'); return { ok: true, runtimeRecovered: true, phase: 'reverted' }; } });

  const hostContext = {
    logger: { warn() {} },
    effect() {},
    agents: { create: async (options) => ({ agent: { id: options.sessionId }, dispose: async () => {} }) },
    tools: {
      get(name) {
        if (name === tool) return candidateVisible ? { execute: async (args) => ({ characters: args.text.length, lines: args.text.split('\n').length }) } : null;
        return kernelTools.get(name) ?? null;
      },
    },
  };
  const host = createDesktopTaskHost(hostContext, { dshHome: home, scanIntervalMs: 10, approvalPollMs: 10, approvalTimeoutMs: 5000, settlePollMs: 1, settleSamples: 4, settleMaxPolls: 20 });
  t.after(async () => { await host.dispose(); });
  await host.start();
  await waitFor(async () => {
    try { await fsp.access(path.join(taskChannelPaths(home).ready)); return true; } catch { return false; }
  });

  // The client runs in the same process here, so its injection points keep the
  // production defaults for launch/readiness and only stub the model-facing
  // system-prompt surface (which is not part of this test).
  const registered = [];
  const clientContext = {
    systemPrompt: { section() {} },
    tools: { register: (definition) => registered.push(definition) },
  };
  applyClient(clientContext, { dshHome: home });
  assert.equal(registered.length, 1);
  const definition = registered[0];
  const execute = (args) => definition.execute(args, { agent: { id: 'acp-session-1' } });

  const delegated = await execute({ action: 'delegate', plan, cwd: home });
  assert.equal(delegated.ok, true, delegated.message);
  assert.equal(delegated.phase, 'awaiting-owner-confirmation');
  assert.equal(delegated.candidateSourceSha256, (await import('../lib/desktop-task-protocol.js')).candidateSourceDigest(hostCode));
  assert.equal(calls.includes('promote-gate'), true);
  assert.equal(calls.includes('promote-confirmed'), false);

  // No confirmation means no promotion: a status call still reports the gate.
  const waiting = await execute({ action: 'status', taskId: delegated.taskId });
  assert.equal(waiting.phase, 'awaiting-owner-confirmation');
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  assert.equal(calls.includes('promote-confirmed'), false);

  const wrong = await execute({
    action: 'confirm', taskId: delegated.taskId, experimentId: delegated.experimentId,
    sourceSha256: 'f'.repeat(64), confirmation: true,
    confirmationText: 'This must not be accepted because the source digest differs.',
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'E_DESKTOP_APPROVAL_MISMATCH');
  assert.equal(calls.includes('promote-confirmed'), false);

  const confirmed = await execute({
    action: 'confirm', taskId: delegated.taskId, experimentId: delegated.experimentId,
    sourceSha256: delegated.candidateSourceSha256, confirmation: true,
    confirmationText: 'Owner approval for the integration candidate.',
  });
  assert.equal(confirmed.ok, true, confirmed.message);
  const stable = await waitFor(async () => {
    const value = await execute({ action: 'status', taskId: delegated.taskId });
    return value.phase === 'stable' ? value : null;
  });
  assert.equal(stable.terminal, true);
  assert.equal(stable.kernelSourceSha256, 'kernel-sha');
  assert.equal(stable.publication.status, 'published');
  assert.deepEqual(stable.publication.approvedProfiles, ['acp']);
  assert.deepEqual(stable.gates, GATES);
  assert.equal(calls.filter((call) => call === 'canary').length, 2);
  assert.equal(calls.includes('revert'), false);
});
