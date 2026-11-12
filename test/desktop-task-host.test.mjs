import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDesktopTaskHost } from '../lib/desktop-task-host.js';
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  candidateSourceDigest,
  mintTaskId,
  taskChannelPaths,
} from '../lib/desktop-task-protocol.js';

const GATES = Object.freeze({
  benefit: true,
  measured: true,
  repeatable: true,
  regression: true,
  reversibility: true,
  cleanup: true,
  noOrphans: true,
  runtimeRecovery: true,
  eligible: true,
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-task-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function planFor(taskId) {
  const tool = `stats_${taskId.slice(-8)}`;
  const host = `const tool = harness.defineTool({ name: '${tool}', execute: async ({ text }) => ({ characters: text.length, lines: text.split('\\n').length }) }); return { name: '${tool}', inject: ['tools'], apply(ctx) { harness.registerTool(ctx, tool); } };`;
  return {
    tool,
    host,
    plan: {
      proposal: {
        why: 'Add a deterministic read-only text statistics tool.',
        target: `plugin:${tool}`,
        impactScope: ['test'],
        successMetrics: ['both samples match'],
      },
      composition: { name: tool, purpose: 'Read-only text statistics', code: { host } },
      verification: {
        targetTool: tool,
        observations: 2,
        samples: [
          { label: 'letters', tool, arguments: { text: 'abc' }, expected: { characters: 3, lines: 1 } },
          { label: 'lines', tool, arguments: { text: 'a\nb' }, expected: { characters: 3, lines: 2 } },
        ],
      },
      requestedTargetProfiles: ['acp'],
    },
  };
}

function requestFor(taskId, plan) {
  return {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId,
    createdAt: new Date().toISOString(),
    requester: { profile: 'acp', sessionId: 'session-test' },
    plan,
    cwd: os.tmpdir(),
  };
}

function fakeKernel({ behavior = 'stable', facts = null } = {}) {
  const calls = [];
  const state = { candidateVisible: false, observations: 0, confirmedPromotions: 0, reverts: 0 };
  const tools = new Map();
  const record = (name, args) => calls.push({ name, args });
  tools.set('evolution_runtime_inspect', { execute: async () => { record('evolution_runtime_inspect', {}); return { components: [], services: [], events: [] }; } });
  tools.set('evolution_propose', { execute: async (args) => { record('evolution_propose', args); return { ok: true, experimentId: 'exp-desktop-task-1', phase: 'proposed' }; } });
  tools.set('evolution_trial', { execute: async (args) => { record('evolution_trial', args); state.candidateVisible = true; return { ok: true, experimentId: 'exp-desktop-task-1', phase: 'trial' }; } });
  tools.set('evolution_measure', { execute: async (args) => { record('evolution_measure', args); return { ok: true, experimentId: 'exp-desktop-task-1', phase: 'measured', gates: GATES, decision: { kind: 'benefit', eligible: true } }; } });
  tools.set('evolution_promote', { execute: async (args) => {
    record('evolution_promote', args);
    if (args.confirmation !== true) {
      if (behavior === 'no-gate') return { ok: true, phase: 'measured', reason: 'mocked gate bypass' };
      return { ok: false, experimentId: 'exp-desktop-task-1', phase: 'awaiting-owner-confirmation', gates: GATES, decision: { kind: 'benefit', eligible: true } };
    }
    state.confirmedPromotions += 1;
    return { ok: true, experimentId: 'exp-desktop-task-1', phase: 'canary-observing' };
  } });
  tools.set('evolution_canary_observe', { execute: async (args) => {
    record('evolution_canary_observe', args);
    state.observations += 1;
    if (facts && state.observations >= 2) await facts.write('exp-desktop-task-1');
    return { stable: state.observations >= 2 };
  } });
  tools.set('evolution_revert', { execute: async (args) => { record('evolution_revert', args); state.reverts += 1; return { ok: true, runtimeRecovered: true, phase: 'reverted' }; } });
  return { calls, state, tools };
}

function fakeCtx(kernel, plan) {
  const created = [];
  return {
    created,
    disposers: [],
    logger: { warn() {} },
    effect(fn) { this.disposers.push(fn()); },
    agents: {
      create: async (options) => {
        created.push(options);
        return { agent: { id: options.sessionId }, dispose: async () => {} };
      },
    },
    tools: {
      get(name) {
        if (name === plan.tool) return kernel.state.candidateVisible ? { execute: async (args) => ({ characters: args.text.length, lines: args.text.split('\n').length }) } : null;
        return kernel.tools.get(name) ?? null;
      },
    },
  };
}

async function waitForState(home, taskId, predicate, timeoutMs = 10_000) {
  const file = path.join(taskChannelPaths(home).state, `${taskId}.json`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`state for ${taskId} did not reach the expected phase`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

function harness(t, options = {}) {
  const home = temporary(t);
  const plan = planFor(mintTaskId());
  const kernel = fakeKernel(options);
  const ctx = fakeCtx(kernel, plan);
  const host = createDesktopTaskHost(ctx, {
    dshHome: home,
    scanIntervalMs: options.scanIntervalMs ?? 10,
    approvalPollMs: 10,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 5000,
    toolTimeoutMs: 1000,
    settlePollMs: 1,
    settleSamples: 4,
    settleMaxPolls: 20,
  });
  t.after(async () => { await host.dispose(); });
  return { home, plan, kernel, ctx, host, channel: taskChannelPaths(home) };
}

async function submit(home, plan, taskId = mintTaskId()) {
  const request = requestFor(taskId, plan.plan);
  const dir = taskChannelPaths(home).inbox;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${taskId}.json`), `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  return taskId;
}

function factsWriter(home) {
  return {
    async write(experimentId) {
      const dataRoot = path.join(home, 'storages', 'evolution');
      await fsp.mkdir(path.join(dataRoot, 'archive', 'experiments'), { recursive: true });
      await fsp.writeFile(path.join(dataRoot, 'archive', 'experiments', `${experimentId}.evidence.json`), JSON.stringify({
        experimentId,
        runtimeRecovered: true,
        recoveryProof: { status: 'recovered' },
        gateEvidence: { gates: GATES },
        publication: { sourceSha256: 'kernel-source-sha' },
      }));
      await fsp.mkdir(path.join(dataRoot, 'shared-plugins'), { recursive: true });
      await fsp.writeFile(path.join(dataRoot, 'shared-plugins', 'published.json'), JSON.stringify({
        schemaVersion: 1,
        plugins: [{
          id: 'evolution-promoted-abc123abc123',
          experimentId,
          pluginName: 'dsh-evolution-promoted-abc123abc123',
          sourceSha256: 'kernel-source-sha',
          approvedProfiles: ['acp'],
          publisherProfile: 'desktop',
          stable: { committedAt: new Date().toISOString() },
        }],
      }));
    },
  };
}

async function approveWhenWaiting(home, taskId, { sourceSha256 = null } = {}) {
  const state = await waitForState(home, taskId, (value) => value.phase === 'awaiting-owner-confirmation');
  const approval = {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId,
    experimentId: sourceSha256 === null ? state.experimentId : 'exp-desktop-task-1',
    sourceSha256: sourceSha256 ?? state.candidateSourceSha256,
    confirmation: true,
    confirmationText: 'Acceptance approval: promote the measured candidate.',
    targetProfiles: ['acp'],
    confirmedAt: new Date().toISOString(),
  };
  const dir = taskChannelPaths(home).approvals;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${taskId}.json`), `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600 });
  return { state, approval };
}

test('a task runs the real kernel sequence and reaches stable after a bound approval', async (t) => {
  const home = temporary(t);
  const plan = planFor(mintTaskId());
  const kernel = fakeKernel({ facts: factsWriter(home) });
  const ctx = fakeCtx(kernel, plan);
  const host = createDesktopTaskHost(ctx, { dshHome: home, scanIntervalMs: 10, approvalPollMs: 10, approvalTimeoutMs: 5000, settlePollMs: 1, settleSamples: 4, settleMaxPolls: 20 });
  t.after(async () => { await host.dispose(); });
  const taskId = await submit(home, plan);
  await host.start();
  await approveWhenWaiting(home, taskId);
  const state = await waitForState(home, taskId, (value) => value.phase === 'stable');
  assert.equal(state.experimentId, 'exp-desktop-task-1');
  assert.equal(state.candidateSourceSha256, candidateSourceDigest(plan.host));
  assert.equal(state.kernelSourceSha256, 'kernel-source-sha');
  assert.deepEqual(state.gates, GATES);
  assert.equal(state.publication.id, 'evolution-promoted-abc123abc123');
  assert.deepEqual(state.publication.approvedProfiles, ['acp']);
  assert.equal(state.result.stable, true);
  assert.equal(state.error, null);
  assert.equal(kernel.state.confirmedPromotions, 1);
  assert.equal(kernel.state.reverts, 0);
  const names = kernel.calls.map((call) => call.name);
  assert.equal(names[0], 'evolution_runtime_inspect');
  assert.ok(names.indexOf('evolution_propose') < names.indexOf('evolution_trial'));
  assert.ok(names.indexOf('evolution_trial') < names.indexOf('evolution_measure'));
  assert.ok(names.indexOf('evolution_measure') < names.indexOf('evolution_promote'));
  const confirmed = kernel.calls.filter((call) => call.name === 'evolution_promote' && call.args.confirmation === true);
  assert.deepEqual(confirmed[0].args.targetProfiles, ['acp']);
  assert.ok(kernel.calls.filter((call) => call.name === 'evolution_canary_observe').every((call) => call.args.startupVerified === true));
  const claimFile = path.join(taskChannelPaths(home).claims, `${taskId}.lock`);
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await fsp.access(claimFile);
    } catch {
      break;
    }
    assert.ok(Date.now() < deadline, 'claim should be released after the task finished');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
});

test('a promotion that leaves the owner gate is treated as a failure and reverted', async (t) => {
  const { home, plan, kernel, host } = harness(t, { behavior: 'no-gate' });
  const taskId = await submit(home, plan);
  await host.start();
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed');
  assert.equal(state.error.code, 'E_DESKTOP_OWNER_GATE_MISSING');
  assert.equal(kernel.state.confirmedPromotions, 0);
  assert.equal(kernel.state.reverts, 1);
  assert.equal(state.revert.ok, true);
});

test('an approval bound to a different identity is rejected and the trial is reverted', async (t) => {
  const { home, plan, kernel, host } = harness(t);
  const taskId = await submit(home, plan);
  await host.start();
  await approveWhenWaiting(home, taskId, { sourceSha256: 'a'.repeat(64) });
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed');
  assert.equal(state.error.code, 'E_DESKTOP_APPROVAL_MISMATCH');
  assert.equal(kernel.state.confirmedPromotions, 0);
  assert.equal(kernel.state.reverts, 1);
  // The approval evidence is preserved for inspection instead of being deleted.
  await fsp.access(path.join(taskChannelPaths(home).approvals, `${taskId}.json`));
});

test('a missing approval times out, leaves the trial reverted, and records no promotion', async (t) => {
  const { home, plan, kernel, host } = harness(t, { approvalTimeoutMs: 300 });
  const taskId = await submit(home, plan);
  await host.start();
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed');
  assert.equal(state.error.code, 'E_DESKTOP_APPROVAL_TIMEOUT');
  assert.equal(kernel.state.confirmedPromotions, 0);
  assert.equal(kernel.state.reverts, 1);
});

test('the host recovery marks a leftover non-terminal task interrupted and never re-runs it', async (t) => {
  const home = temporary(t);
  const paths = taskChannelPaths(home);
  await fsp.mkdir(paths.state, { recursive: true });
  const taskId = mintTaskId();
  await fsp.writeFile(path.join(paths.state, `${taskId}.json`), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId,
    phase: 'awaiting-owner-confirmation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    experimentId: 'exp-old',
    candidateSourceSha256: 'b'.repeat(64),
  }));
  const plan = planFor(taskId);
  const kernel = fakeKernel();
  const host = createDesktopTaskHost(fakeCtx(kernel, plan), { dshHome: home, scanIntervalMs: 0, settlePollMs: 1 });
  t.after(async () => { await host.dispose(); });
  await host.start();
  const state = await waitForState(home, taskId, (value) => value.phase === 'interrupted');
  assert.equal(state.error.code, 'E_DESKTOP_HOST_LOST');
  assert.equal(kernel.calls.length, 0, 'recovery must not execute any tool');
  assert.equal(kernel.state.reverts, 0);
});

test('two requests are executed one at a time in created order', async (t) => {
  const home = temporary(t);
  const planA = planFor(mintTaskId());
  const planB = planFor(mintTaskId());
  let candidate = null;
  const kernelA = fakeKernel({ facts: factsWriter(home) });
  const kernelB = fakeKernel({ facts: factsWriter(home) });
  const calls = [];
  const ctx = {
    logger: { warn() {} },
    effect() {},
    agents: { create: async (options) => ({ agent: { id: options.sessionId }, dispose: async () => {} }) },
    tools: {
      get(name) {
        if (name === planA.tool || name === planB.tool) {
          return candidate === name ? { execute: async (args) => ({ characters: args.text.length, lines: args.text.split('\n').length }) } : null;
        }
        const tool = kernelA.tools.get(name) ?? kernelB.tools.get(name);
        if (!tool) return null;
        return { execute: async (args, exec) => {
          calls.push({ name, args, active: candidate });
          if (name === 'evolution_trial') candidate = args.composition.name === planA.plan.composition.name ? planA.tool : planB.tool;
          return tool.execute(args, exec);
        } };
      },
    },
  };
  const host = createDesktopTaskHost(ctx, { dshHome: home, scanIntervalMs: 10, approvalPollMs: 10, approvalTimeoutMs: 5000, settlePollMs: 1, settleSamples: 4, settleMaxPolls: 20 });
  t.after(async () => { await host.dispose(); });
  const first = await submit(home, planA);
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  const second = await submit(home, planB);
  await host.start();
  await approveWhenWaiting(home, first);
  await approveWhenWaiting(home, second);
  const firstState = await waitForState(home, first, (value) => value.phase === 'stable');
  const secondState = await waitForState(home, second, (value) => value.phase === 'stable');
  assert.equal(firstState.phase, 'stable');
  assert.equal(secondState.phase, 'stable');
  // The second trial starts only after the first task's canary finished. Each
  // recorded call names the trial it belonged to through the fake candidate
  // visibility: canary observations keep the task's tool as the active one.
  const firstStableAt = calls.findLastIndex((call) => call.name === 'evolution_canary_observe' && call.active === planA.tool);
  const secondTrialAt = calls.findIndex((call) => call.name === 'evolution_trial' && call.args.composition?.name === planB.plan.composition.name);
  assert.ok(firstStableAt >= 0 && secondTrialAt >= 0, 'both tasks must have run their trial and canary');
  assert.ok(secondTrialAt > firstStableAt, 'the second task started before the first reached its canary barrier');
});

test('a claim owned by a live foreign process keeps the task from executing', async (t) => {
  const { home, plan, kernel, host, channel } = harness(t);
  const taskId = mintTaskId();
  await fsp.mkdir(channel.claims, { recursive: true });
  // PID 1 is alive on this machine and is not this process.
  await fsp.writeFile(path.join(channel.claims, `${taskId}.lock`), JSON.stringify({ pid: 1, instanceId: 'foreign', at: new Date().toISOString() }));
  await submit(home, plan, taskId);
  await host.start();
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed');
  assert.equal(state.error.code, 'E_DESKTOP_TASK_CLAIMED');
  assert.equal(kernel.calls.length, 0);
});

test('a malformed request becomes a durable failed state without executing tools', async (t) => {
  const { home, kernel, host, channel } = harness(t);
  const taskId = mintTaskId();
  await fsp.mkdir(channel.inbox, { recursive: true });
  await fsp.writeFile(path.join(channel.inbox, `${taskId}.json`), JSON.stringify({ schemaVersion: SCHEMA_VERSION, protocol: PROTOCOL_VERSION, taskId, createdAt: new Date().toISOString(), requester: { profile: 'acp' }, plan: {} }));
  await host.start();
  const state = await waitForState(home, taskId, (value) => value.phase === 'failed');
  assert.equal(state.error.code, 'E_DESKTOP_TASK_INVALID');
  assert.equal(kernel.calls.length, 0);
});
