import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  TASK_ID_PATTERN,
  candidateSourceDigest,
  canTransition,
  createTaskState,
  isTerminalPhase,
  listJsonFiles,
  mintTaskId,
  pidAlive,
  projectTaskState,
  readJson,
  readReady,
  taskChannelPaths,
  transitionTaskState,
  validateApproval,
  validateTaskRequest,
  validateTaskState,
  writeJson,
} from '../lib/desktop-task-protocol.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-task-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function validPlan() {
  return {
    proposal: {
      why: 'The owner asked for a deterministic read-only text statistics tool.',
      target: 'plugin:text-stats',
      impactScope: ['isolated-acceptance'],
      successMetrics: ['both sample calls return the expected counts'],
    },
    composition: {
      name: 'text-stats',
      purpose: 'Read-only text statistics; no filesystem, network, or process access',
      code: { host: 'return { name: "text-stats", inject: ["tools"], apply() {} };' },
    },
    verification: {
      targetTool: 'text_stats',
      observations: 2,
      samples: [
        { label: 'letters', tool: 'text_stats', arguments: { text: 'abc' }, expected: { characters: 3, lines: 1 } },
        { label: 'lines', tool: 'text_stats', arguments: { text: 'a\nb' }, expected: { characters: 3, lines: 2 } },
      ],
    },
    requestedTargetProfiles: ['acp'],
  };
}

function validRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId: mintTaskId(),
    createdAt: new Date().toISOString(),
    requester: { profile: 'acp', sessionId: 'session-1' },
    plan: validPlan(),
    cwd: os.tmpdir(),
    ...overrides,
  };
}

test('task ids and candidate digests are stable and bounded', () => {
  const id = mintTaskId(1, 'deadbeef');
  assert.match(id, TASK_ID_PATTERN);
  assert.equal(mintTaskId(1, 'deadbeef'), id);
  assert.notEqual(mintTaskId(1, 'cafebabe'), id);
  assert.equal(candidateSourceDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => candidateSourceDigest(1));
});

test('channel paths live under one DSH_HOME evolution storage', () => {
  const paths = taskChannelPaths('/tmp/home');
  assert.equal(paths.root, '/tmp/home/storages/evolution/desktop-tasks');
  assert.equal(paths.ready, '/tmp/home/storages/evolution/desktop-tasks/host.json');
  assert.equal(paths.inbox, '/tmp/home/storages/evolution/desktop-tasks/inbox');
  assert.equal(paths.state, '/tmp/home/storages/evolution/desktop-tasks/state');
  assert.equal(paths.approvals, '/tmp/home/storages/evolution/desktop-tasks/approvals');
  assert.equal(paths.claims, '/tmp/home/storages/evolution/desktop-tasks/claims');
});

test('a valid request is accepted and normalized plan shapes are preserved', () => {
  const request = validRequest();
  const result = validateTaskRequest(request);
  assert.equal(result.ok, true, result.issues?.join(', '));
  assert.deepEqual(result.value, request);
});

test('request validation rejects unknown, unbounded, and malformed fields', () => {
  const cases = [
    { ...validRequest(), extra: true },
    { ...validRequest(), schemaVersion: 2 },
    { ...validRequest(), protocol: 2 },
    { ...validRequest(), taskId: '../escape' },
    { ...validRequest(), createdAt: 'not-a-date' },
    { ...validRequest(), cwd: 'relative/path' },
    { ...validRequest(), requester: { profile: 'web' } },
    { ...validRequest(), requester: { profile: 'acp', sessionId: '' } },
  ];
  for (const value of cases) assert.equal(validateTaskRequest(value).ok, false);

  const badPlan = (mutate) => {
    const request = validRequest();
    const plan = structuredClone(request.plan);
    mutate(plan);
    return { ...request, plan };
  };
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.composition.code.host = ''; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.composition.code.host = 'x'.repeat(49 * 1024); })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.verification.samples = []; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { delete plan.verification.samples[0].expected; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.verification.samples[0].expected = new Date(); })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.verification.samples[0].arguments = { value: 1n }; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.verification.observations = 0; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.requestedTargetProfiles = ['desktop']; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.requestedTargetProfiles = ['acp', 'acp']; })).ok, false);
  assert.equal(validateTaskRequest(badPlan((plan) => { plan.proposal.why = 7; })).ok, false);
});

test('phase transitions are closed and terminal phases never move', () => {
  for (const phase of ['stable', 'failed', 'interrupted', 'cancelled']) assert.equal(isTerminalPhase(phase), true);
  assert.equal(isTerminalPhase('running'), false);
  assert.equal(canTransition('accepted', 'running'), true);
  assert.equal(canTransition('running', 'awaiting-owner-confirmation'), true);
  assert.equal(canTransition('awaiting-owner-confirmation', 'promoting'), true);
  assert.equal(canTransition('promoting', 'canary-observing'), true);
  assert.equal(canTransition('canary-observing', 'stable'), true);
  assert.equal(canTransition('accepted', 'stable'), false);
  assert.equal(canTransition('stable', 'running'), false);
  assert.equal(canTransition('failed', 'failed'), false);

  const initial = createTaskState({ taskId: mintTaskId(), host: { instanceId: 'host-1' } });
  const running = transitionTaskState(initial, 'running');
  assert.equal(running.phase, 'running');
  assert.equal(initial.phase, 'accepted', 'transition returns a new object');
  assert.throws(() => transitionTaskState(initial, 'stable'), /illegal task phase transition/);
  assert.throws(() => transitionTaskState(initial, 'bogus'), /unknown phase/);
});

test('state validation rejects malformed documents', () => {
  const state = createTaskState({ taskId: mintTaskId() });
  assert.equal(validateTaskState(state).ok, true);
  assert.equal(validateTaskState({ ...state, phase: 'nope' }).ok, false);
  assert.equal(validateTaskState({ ...state, taskId: 'a/b' }).ok, false);
  assert.equal(validateTaskState(null).ok, false);
});

test('approval validation enforces the bound identity and explicit confirmation', () => {
  const approval = {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId: mintTaskId(),
    experimentId: 'exp-1',
    sourceSha256: candidateSourceDigest('candidate'),
    confirmation: true,
    confirmationText: '用户已明确确认晋升该候选。',
    targetProfiles: ['acp'],
    confirmedAt: new Date().toISOString(),
  };
  assert.equal(validateApproval(approval).ok, true);
  assert.equal(validateApproval({ ...approval, confirmation: false }).ok, false);
  assert.equal(validateApproval({ ...approval, confirmation: 'yes' }).ok, false);
  assert.equal(validateApproval({ ...approval, confirmationText: '' }).ok, false);
  assert.equal(validateApproval({ ...approval, experimentId: '../x' }).ok, false);
  assert.equal(validateApproval({ ...approval, sourceSha256: 'abc' }).ok, false);
  assert.equal(validateApproval({ ...approval, targetProfiles: ['acp', 'acp'] }).ok, false);
  assert.equal(validateApproval({ ...approval, targetProfiles: ['desktop'] }).ok, false);
  assert.equal(validateApproval({ ...approval, unexpected: 1 }).ok, false);
  assert.equal(validateApproval({ ...approval, confirmedAt: 'later' }).ok, false);
});

test('atomic json helpers round-trip and report missing documents as null', async (t) => {
  const home = temporary(t);
  const paths = taskChannelPaths(home);
  assert.equal(await readJson(path.join(paths.inbox, 'missing.json')), null);
  assert.deepEqual(await listJsonFiles(paths.inbox), []);
  await writeJson(path.join(paths.inbox, 'a.json'), { ok: 1 });
  await writeJson(path.join(paths.inbox, 'b.json'), { ok: 2 });
  assert.deepEqual(await listJsonFiles(paths.inbox), [
    path.join(paths.inbox, 'a.json'),
    path.join(paths.inbox, 'b.json'),
  ]);
  assert.deepEqual(await readJson(path.join(paths.inbox, 'a.json')), { ok: 1 });
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(paths.inbox, 'a.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('ready documents require a live pid and the matching protocol', async (t) => {
  const home = temporary(t);
  const paths = taskChannelPaths(home);
  assert.equal(await readReady(home), null);
  await writeJson(paths.ready, {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    instanceId: 'instance-1',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: { dsh: '0.2.2-rc.1', cordis: '4.1.0', node: process.versions.node },
    profile: 'desktop',
  });
  const ready = await readReady(home);
  assert.equal(ready.instanceId, 'instance-1');
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
  assert.equal(pidAlive('123'), false);

  await writeJson(paths.ready, { ...ready, protocol: 99 });
  assert.equal(await readReady(home), null);
});

test('the client projection stays bounded and never leaks host paths', () => {
  const state = {
    ...createTaskState({ taskId: mintTaskId() }),
    phase: 'awaiting-owner-confirmation',
    experimentId: 'exp-1',
    candidateSourceSha256: candidateSourceDigest('candidate'),
    gates: { benefit: true, measured: true, repeatable: true, regression: true, reversibility: true, cleanup: true, noOrphans: true, runtimeRecovery: true, eligible: true, extra: 'nope' },
    decision: { kind: 'benefit', eligible: true, reasons: ['r1'], secret: 'x' },
    error: { code: 'E_X', message: 'm'.repeat(900) },
    result: { summary: 's', stable: false, observations: 2 },
    host: { path: '/Users/private' },
  };
  const projected = projectTaskState(state);
  assert.equal(projected.phase, 'awaiting-owner-confirmation');
  assert.equal(projected.terminal, false);
  assert.equal(projected.error.message.length, 500);
  assert.equal(projected.host, undefined);
  assert.equal(projected.gates.eligible, true);
  assert.equal(projected.gates.extra, undefined);
  assert.equal(projected.decision.secret, undefined);
  assert.equal(projected.taskId, state.taskId);
  assert.equal(projectTaskState(null), null);
});
