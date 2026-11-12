/**
 * Focused tests for the ACP-side Desktop task client.
 *
 * Every test uses an isolated `dshHome` under `fs.mkdtemp()`. Host readiness
 * files and task state files are written through the real protocol module, so
 * the client is exercised against the same documents the Desktop host owns.
 * `spawn` is always injected: no test starts the real Desktop application or
 * Electron, and nothing reads the operator's `~/.dsh`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  SYSTEM_PROMPT_ORDER,
  SYSTEM_PROMPT_SECTION,
  TOOL_NAME,
  apply,
} from '../lib/desktop-task-client.js';
import { sha256 } from '../lib/promoted-sharing.js';
import { evolutionPackageVersion } from '../lib/self-evolution-review.js';
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  candidateSourceDigest,
  createTaskState,
  listJsonFiles,
  readJson,
  taskChannelPaths,
  transitionTaskState,
  validateApproval,
  validateTaskRequest,
  writeJson,
} from '../lib/desktop-task-protocol.js';

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function tempHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-task-client-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

const PLAN = Object.freeze({
  proposal: {
    why: 'ACP sessions need a read-only lookup tool for the smoke-test data.',
    target: 'Add a deterministic read-only smoke-test tool to the ACP profile.',
    impactScope: ['acp'],
    successMetrics: ['All deterministic samples return the expected JSON.'],
  },
  composition: {
    name: 'desktop-client-smoke-tool',
    purpose: 'Return the deterministic smoke-test fixture without side effects.',
    code: {
      host: [
        'return { name: "desktop-client-smoke-tool", inject: ["tools"], apply(ctx) {',
        '  const tool = harness.defineTool({ name: "desktop_client_smoke", description: "read only", parameters: {}, output: { schema: {}, render: () => [] }, isConcurrencySafe: () => true, execute: async () => ({ ok: true }) });',
        '  harness.registerTool(ctx, tool);',
        '} };',
      ].join('\n'),
    },
  },
  verification: {
    targetTool: 'desktop_client_smoke',
    observations: 1,
    samples: [
      { label: 'fixed sample', tool: 'desktop_client_smoke', arguments: {}, expected: { ok: true } },
    ],
  },
  requestedTargetProfiles: ['acp'],
});

function readyDocument(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    instanceId: 'test-desktop-instance',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host: { dsh: '0.2.2-rc.1', cordis: '4.1.0', node: process.version },
    profile: 'desktop',
    ...overrides,
  };
}

async function writeReady(home, overrides = {}) {
  await writeJson(taskChannelPaths(home).ready, readyDocument(overrides));
}

function phaseSequence(phase) {
  switch (phase) {
    case 'accepted': return [];
    case 'running': return ['running'];
    case 'awaiting-owner-confirmation': return ['running', 'awaiting-owner-confirmation'];
    case 'promoting': return ['running', 'promoting'];
    case 'canary-observing': return ['running', 'promoting', 'canary-observing'];
    case 'stable': return ['running', 'stable'];
    case 'failed': return ['running', 'failed'];
    case 'interrupted': return ['running', 'interrupted'];
    case 'cancelled': return ['running', 'cancelled'];
    default: throw new Error(`unsupported test phase: ${phase}`);
  }
}

function makeState(taskId, phase, patch = {}) {
  let state = createTaskState({ taskId });
  for (const next of phaseSequence(phase)) state = transitionTaskState(state, next);
  return { ...state, ...patch, phase, updatedAt: patch.updatedAt ?? new Date().toISOString() };
}

async function writeState(home, state) {
  await writeJson(path.join(taskChannelPaths(home).state, `${state.taskId}.json`), state);
}

/**
 * Mount the entry with a fake tools registry and a spawn that fails the test if
 * used. An optional `get` override supplies the live Cordis services the audit
 * action reads (pluginPackages / profileContext / evolutionExperience).
 */
function mount(home, overrides = {}) {
  const tools = new Map();
  const sections = [];
  const { get: getService, ...config } = overrides;
  const ctx = {
    ...(typeof getService === 'function' ? { get: getService } : {}),
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => { tools.delete(definition.name); };
      },
    },
    systemPrompt: {
      section: (section) => { sections.push(section); },
    },
  };
  const client = apply(ctx, {
    dshHome: home,
    platform: 'darwin',
    spawn: () => { throw new Error('the test did not expect a Desktop launch'); },
    launchPollMs: 5,
    launchTimeoutMs: 200,
    statePollMs: 10,
    delegateTimeoutMs: 3000,
    ...config,
  });
  return { tool: tools.get(TOOL_NAME), tools, sections, client };
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Recursive path -> bytes map, used to prove the audit writes nothing. */
async function treeSnapshot(root) {
  const files = new Map();
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.set(path.relative(root, file), (await fs.readFile(file)).toString('hex'));
    }
  }
  await walk(root);
  return files;
}

const LIVE_HOST_VERSIONS = Object.freeze({
  '@deepseek-ai/dsh': '0.3.0',
  '@deepseek-ai/cordis': '4.1.2',
  '@deepseek-ai/cordis-plugin-include': '2.0.3',
});

function liveHostServices(versions = LIVE_HOST_VERSIONS) {
  return {
    pluginPackages: {
      packageOf: (name) => (Object.hasOwn(versions, name) ? { version: versions[name] } : null),
    },
    profileContext: { name: 'acp' },
  };
}

/** A complete published record whose source bytes exist under pluginRoot. */
async function writePublishedRecord(home, overrides = {}) {
  const dataRoot = path.join(home, 'storages', 'evolution');
  const id = overrides.id ?? 'evolution-promoted-abc123abc123';
  const pluginName = `dsh-${id}`;
  const pluginDir = path.join(dataRoot, 'promoted', pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const moduleBytes = 'export const name = "published-fixture";\n';
  const manifestBytes = `${JSON.stringify({ name: pluginName, version: '1.0.0' })}\n`;
  await fs.writeFile(path.join(pluginDir, 'lib', 'index.js'), moduleBytes);
  await fs.writeFile(path.join(pluginDir, 'package.json'), manifestBytes);
  const record = {
    schemaVersion: 1,
    id,
    experimentId: 'experiment-published-fixture',
    pluginName,
    entry: 'lib/index.js',
    moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href,
    sourceSha256: sha256(moduleBytes),
    manifestSha256: sha256(manifestBytes),
    publisherProfile: 'desktop',
    approvedProfiles: ['acp'],
    stable: {
      committedAt: '2026-01-01T00:00:00.000Z',
      decision: 'benefit',
      canary: { startupVerified: true, healthObservationWindow: 1, observations: 1 },
    },
    requiredServices: [],
    serviceMembers: {},
    requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include'],
    hostOnly: true,
    host: { dsh: '0.2.2', cordis: '4.1.2', include: '2.0.3', node: process.version },
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  await fs.mkdir(path.join(dataRoot, 'shared-plugins'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'shared-plugins', 'published.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plugins: [record],
  })}\n`);
  return record;
}

/**
 * A deterministic stand-in for the Desktop host: after the request file appears
 * it writes each supplied state document, in order. It never starts a process
 * and never reads a real data directory.
 */
function simulateDesktop(home, taskId, steps) {
  const paths = taskChannelPaths(home);
  const inboxFile = path.join(paths.inbox, `${taskId}.json`);
  let stopped = false;
  const done = (async () => {
    const deadline = Date.now() + 5000;
    while (!stopped && Date.now() < deadline) {
      try {
        await fs.access(inboxFile);
        break;
      } catch {
        await delay(5);
      }
    }
    if (stopped) return;
    for (const step of steps) {
      if (stopped) return;
      await writeJson(path.join(paths.state, `${taskId}.json`), step);
      await delay(25);
    }
  })();
  return {
    done,
    stop() { stopped = true; },
  };
}

test('the tool exposes a valid JSON Schema, a text renderer, and one prompt section', async (t) => {
  const home = await tempHome(t);
  const { tool, sections } = mount(home);

  assert.ok(tool, 'evolution_desktop is registered');
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.deepEqual(tool.parameters.properties.action.enum, ['audit', 'delegate', 'status', 'confirm']);
  assert.equal(tool.parameters.properties.plan.type, 'object');
  assert.deepEqual(tool.parameters.properties.plan.required, ['proposal', 'composition', 'verification']);
  assert.equal(tool.parameters.properties.plan.properties.composition.required.includes('code'), true);
  assert.equal(tool.parameters.properties.plan.properties.verification.properties.observations.minimum, 1);
  assert.equal(tool.parameters.properties.plan.properties.verification.properties.observations.maximum, 5);
  const proposal = tool.parameters.properties.plan.properties.proposal;
  assert.equal(proposal.properties.strategy.maxLength, 4096);
  assert.equal(proposal.properties.rootCause.maxLength, 2000);
  assert.equal(proposal.required.includes('strategy'), false);
  assert.equal(proposal.required.includes('rootCause'), false);
  assert.equal(tool.parameters.properties.focus.maxLength, 240);
  assert.equal(tool.parameters.properties.minOccurrences.minimum, 1);
  assert.equal(tool.parameters.properties.limit.maximum, 5);
  assert.deepEqual(tool.parameters.properties.targetProfiles.items.enum, ['acp', 'web']);
  assert.equal(tool.parameters.properties.waitMs.maximum, 120000);
  assert.deepEqual(tool.output.schema, {});
  assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }]);

  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, SYSTEM_PROMPT_SECTION);
  assert.equal(sections[0].order, SYSTEM_PROMPT_ORDER);
  assert.equal(sections[0].order, 117);
  assert.match(sections[0].text, /awaiting-owner-confirmation/);
  assert.match(sections[0].text, /confirmationText/);
  assert.match(sections[0].text, /harness\.defineTool/);
  assert.match(sections[0].text, /never reuse an approval/);
  assert.match(sections[0].text, /call action "audit"/);
  assert.match(sections[0].text, /selfEvolution\.nextActions/);
  assert.match(sections[0].text, /revalidation is not/);
  assert.match(sections[0].text, /explicit owner confirmation/);
});

test('delegate writes a validated request and returns after the phase advances', async (t) => {
  const home = await tempHome(t);
  await writeReady(home);
  let spawnCalls = 0;
  const { tool } = mount(home, {
    spawn: () => { spawnCalls += 1; return { unref() {}, on() {} }; },
  });

  const taskId = 'desktop-task-delegate-1';
  const sourceSha256 = candidateSourceDigest(PLAN.composition.code.host);
  const simulator = simulateDesktop(home, taskId, [
    makeState(taskId, 'running'),
    makeState(taskId, 'awaiting-owner-confirmation', {
      experimentId: 'experiment-delegate-1',
      candidateSourceSha256: sourceSha256,
    }),
  ]);
  t.after(() => simulator.stop());

  const result = await tool.execute(
    { action: 'delegate', plan: PLAN, cwd: home, taskId },
    { agent: { id: 'acp-session-42' } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'delegate');
  assert.equal(result.taskId, taskId);
  assert.equal(result.phase, 'awaiting-owner-confirmation');
  assert.equal(result.experimentId, 'experiment-delegate-1');
  assert.equal(result.candidateSourceSha256, sourceSha256);
  assert.equal(result.terminal, false);
  assert.equal(spawnCalls, 0, 'a live host must not be launched');

  const request = await readJson(path.join(taskChannelPaths(home).inbox, `${taskId}.json`));
  assert.deepEqual(validateTaskRequest(request), { ok: true, value: request });
  assert.equal(request.schemaVersion, SCHEMA_VERSION);
  assert.equal(request.protocol, PROTOCOL_VERSION);
  assert.equal(request.requester.profile, 'acp');
  assert.equal(request.requester.sessionId, 'acp-session-42');
  assert.equal(request.cwd, home);
  assert.deepEqual(request.plan, JSON.parse(JSON.stringify(PLAN)));

  // The in-process memory answers a status call that omits taskId.
  const status = await tool.execute({ action: 'status' }, { agent: { id: 'acp-session-42' } });
  assert.equal(status.ok, true);
  assert.equal(status.action, 'status');
  assert.equal(status.taskId, taskId);
  assert.equal(status.phase, 'awaiting-owner-confirmation');

  simulator.stop();
  await simulator.done;
});

test('delegate reports E_DESKTOP_TASK_SLOW with the task id and last state', async (t) => {
  const home = await tempHome(t);
  await writeReady(home);
  const { tool } = mount(home, { delegateTimeoutMs: 80, statePollMs: 5 });
  const taskId = 'desktop-task-slow-1';

  const result = await tool.execute({ action: 'delegate', plan: PLAN, taskId }, {});

  assert.equal(result.ok, false);
  assert.equal(result.action, 'delegate');
  assert.equal(result.code, 'E_DESKTOP_TASK_SLOW');
  assert.equal(result.taskId, taskId);
  assert.equal(result.phase, null);
  assert.equal(result.state, null);
  assert.match(result.message, /status/);
  assert.ok(result.message.length <= 500);

  const requests = await listJsonFiles(taskChannelPaths(home).inbox);
  assert.equal(requests.length, 1, 'the request is kept on disk for a later status call');
  const request = await readJson(requests[0]);
  assert.equal(validateTaskRequest(request).ok, true);
  assert.equal(Object.hasOwn(request.requester, 'sessionId'), false, 'an absent execution context omits the session id');
});

test('delegate launches the official app and reports an actionable error when it never becomes ready', async (t) => {
  const home = await tempHome(t);
  const calls = [];
  const fakeSpawn = (binary, args, options) => {
    calls.push({ binary, args, options });
    return { unref() {}, on() {} };
  };
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  });

  const { tool } = mount(home, {
    spawn: fakeSpawn,
    appBinaryPath: '/opt/fake/DeepSeek Harness',
    launchTimeoutMs: 80,
    launchPollMs: 5,
  });

  const result = await tool.execute(
    { action: 'delegate', plan: PLAN, taskId: 'desktop-task-launch-1' },
    { agent: { id: 'acp-session-42' } },
  );

  assert.equal(result.ok, false);
  assert.equal(result.action, 'delegate');
  assert.equal(result.code, 'E_DESKTOP_HOST_UNAVAILABLE');
  assert.match(result.message, /relaunch|restart/i);
  assert.match(result.message, /DeepSeek Harness/);
  assert.ok(result.message.length <= 500);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, '/opt/fake/DeepSeek Harness');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.env.DSH_HOME, home);
  assert.equal('ELECTRON_RUN_AS_NODE' in calls[0].options.env, false);

  assert.deepEqual(await listJsonFiles(taskChannelPaths(home).inbox), []);
});

test('delegate refuses to start the Desktop on a non-macOS platform', async (t) => {
  const home = await tempHome(t);
  let spawnCalls = 0;
  const { tool } = mount(home, {
    platform: 'linux',
    spawn: () => { spawnCalls += 1; return { unref() {}, on() {} }; },
  });

  const result = await tool.execute({ action: 'delegate', plan: PLAN, taskId: 'desktop-task-platform-1' }, {});

  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_DESKTOP_UNSUPPORTED_PLATFORM');
  assert.match(result.message, /macOS/);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(await listJsonFiles(taskChannelPaths(home).inbox), []);
});

test('delegate starts the app when no host is live and then reads the task state', async (t) => {
  const home = await tempHome(t);
  let spawnCalls = 0;
  const fakeSpawn = () => {
    spawnCalls += 1;
    setTimeout(() => { void writeReady(home).catch(() => {}); }, 10);
    return { unref() {}, on() {} };
  };
  const taskId = 'desktop-task-launch-ok-1';
  await writeState(home, makeState(taskId, 'stable', {
    result: { summary: 'stable', stable: true, observations: 1 },
  }));
  // An identical retry is idempotent: the request on disk matches this plan,
  // so the client returns the existing state instead of starting a new task.
  await writeJson(path.join(taskChannelPaths(home).inbox, `${taskId}.json`), {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId,
    createdAt: new Date().toISOString(),
    requester: { profile: 'acp' },
    plan: PLAN,
  });

  const { tool } = mount(home, {
    spawn: fakeSpawn,
    launchPollMs: 5,
    launchTimeoutMs: 2000,
    delegateTimeoutMs: 2000,
  });

  const result = await tool.execute({ action: 'delegate', plan: PLAN, taskId }, {});

  assert.equal(result.ok, true);
  assert.equal(result.phase, 'stable');
  assert.equal(result.terminal, true);
  assert.equal(result.result.stable, true);
  assert.equal(spawnCalls, 1);
});

test('delegate rejects a taskId that already exists with a different request', async (t) => {
  const home = await tempHome(t);
  await writeReady(home);
  const taskId = 'desktop-task-conflict-1';
  await writeState(home, makeState(taskId, 'awaiting-owner-confirmation', { experimentId: 'exp-old', candidateSourceSha256: 'a'.repeat(64) }));
  const { tool } = mount(home, { delegateTimeoutMs: 500 });
  const result = await tool.execute({ action: 'delegate', plan: PLAN, taskId }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_DESKTOP_TASK_ID_CONFLICT');
});

test('status waits for a phase change and reports the new phase', async (t) => {
  const home = await tempHome(t);
  const taskId = 'desktop-task-status-1';
  const sourceSha256 = candidateSourceDigest('candidate source');
  await writeState(home, makeState(taskId, 'running'));
  // The timer writes through the real state writer. Keep the promise so the
  // test never ends (and the temp home is never removed) while that write is
  // still in flight: an unawaited write used to surface as an ENOENT after the
  // test finished.
  let pendingWrite = null;
  const timer = setTimeout(() => {
    pendingWrite = writeState(home, makeState(taskId, 'awaiting-owner-confirmation', {
      experimentId: 'experiment-status-1',
      candidateSourceSha256: sourceSha256,
    }));
  }, 60);
  t.after(() => clearTimeout(timer));

  const { tool } = mount(home, { statePollMs: 10 });
  const result = await tool.execute({ action: 'status', taskId, waitMs: 2000 }, {});
  await pendingWrite?.catch(() => {});

  assert.equal(result.ok, true);
  assert.equal(result.action, 'status');
  assert.equal(result.taskId, taskId);
  assert.equal(result.phase, 'awaiting-owner-confirmation');
  assert.equal(result.experimentId, 'experiment-status-1');
  assert.equal(result.candidateSourceSha256, sourceSha256);
});

test('status does not wait by default, and finds the newest state when no taskId is given', async (t) => {
  const home = await tempHome(t);
  const older = makeState('desktop-task-older-1', 'running', { updatedAt: '2026-01-01T00:00:00.000Z' });
  const newer = makeState('desktop-task-newer-1', 'awaiting-owner-confirmation', {
    updatedAt: '2026-02-01T00:00:00.000Z',
    experimentId: 'experiment-newer-1',
    candidateSourceSha256: candidateSourceDigest('newer candidate'),
  });
  await writeState(home, older);
  await writeState(home, newer);

  const { tool } = mount(home, { statePollMs: 10 });
  const started = Date.now();
  const result = await tool.execute({ action: 'status' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.taskId, 'desktop-task-newer-1');
  assert.equal(result.phase, 'awaiting-owner-confirmation');
  assert.ok(Date.now() - started < 1000, 'waitMs defaults to 0');

  const emptyHome = await tempHome(t);
  const { tool: emptyTool } = mount(emptyHome);
  const missing = await emptyTool.execute({ action: 'status' }, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.action, 'status');
  assert.equal(missing.code, 'E_DESKTOP_TASK_NOT_FOUND');
});

test('confirm refuses every path that is not an exact, explicitly confirmed pending candidate', async (t) => {
  const home = await tempHome(t);
  const { tool } = mount(home);
  const paths = taskChannelPaths(home);
  const approvalFile = (taskId) => path.join(paths.approvals, `${taskId}.json`);
  const sourceSha256 = candidateSourceDigest('confirmed candidate');
  const experimentId = 'experiment-confirm-1';

  const runningTaskId = 'desktop-task-confirm-running-1';
  await writeState(home, makeState(runningTaskId, 'running'));
  const notAwaiting = await tool.execute({
    action: 'confirm',
    taskId: runningTaskId,
    experimentId,
    sourceSha256,
    confirmation: true,
    confirmationText: 'Please promote this candidate.',
  }, {});
  assert.equal(notAwaiting.ok, false);
  assert.equal(notAwaiting.code, 'E_DESKTOP_TASK_NOT_AWAITING_CONFIRMATION');
  assert.equal(notAwaiting.action, 'confirm');
  assert.equal(await readJson(approvalFile(runningTaskId)), null);

  const awaitingTaskId = 'desktop-task-confirm-awaiting-1';
  await writeState(home, makeState(awaitingTaskId, 'awaiting-owner-confirmation', {
    experimentId,
    candidateSourceSha256: sourceSha256,
  }));

  const base = { action: 'confirm', taskId: awaitingTaskId, confirmation: true, confirmationText: 'Please promote this candidate.' };

  const wrongExperiment = await tool.execute({ ...base, experimentId: 'experiment-other-1', sourceSha256 }, {});
  assert.equal(wrongExperiment.ok, false);
  assert.equal(wrongExperiment.code, 'E_DESKTOP_APPROVAL_MISMATCH');
  assert.equal(await readJson(approvalFile(awaitingTaskId)), null);

  const wrongSource = await tool.execute({ ...base, experimentId, sourceSha256: candidateSourceDigest('other candidate') }, {});
  assert.equal(wrongSource.ok, false);
  assert.equal(wrongSource.code, 'E_DESKTOP_APPROVAL_MISMATCH');
  assert.equal(await readJson(approvalFile(awaitingTaskId)), null);

  const confirmationFalse = await tool.execute({ ...base, experimentId, sourceSha256, confirmation: false }, {});
  assert.equal(confirmationFalse.ok, false);
  assert.equal(confirmationFalse.code, 'E_DESKTOP_APPROVAL_CONFIRMATION_REQUIRED');
  assert.equal(await readJson(approvalFile(awaitingTaskId)), null);

  const confirmationMissing = await tool.execute({ ...base, experimentId, sourceSha256, confirmation: undefined }, {});
  assert.equal(confirmationMissing.ok, false);
  assert.equal(confirmationMissing.code, 'E_DESKTOP_APPROVAL_CONFIRMATION_REQUIRED');
  assert.equal(await readJson(approvalFile(awaitingTaskId)), null);

  const blankText = await tool.execute({ ...base, experimentId, sourceSha256, confirmationText: '   ' }, {});
  assert.equal(blankText.ok, false);
  assert.equal(blankText.code, 'E_DESKTOP_APPROVAL_INVALID');
  assert.equal(await readJson(approvalFile(awaitingTaskId)), null);

  const invalidProfile = await tool.execute({ ...base, experimentId, sourceSha256, targetProfiles: ['desktop'] }, {});
  assert.equal(invalidProfile.ok, false);
  assert.equal(invalidProfile.code, 'E_DESKTOP_APPROVAL_INVALID');
  assert.equal(await readJson(approvalFile(awaitingTaskId)), null);

  const stateAfter = await readJson(path.join(paths.state, `${awaitingTaskId}.json`));
  assert.equal(stateAfter.phase, 'awaiting-owner-confirmation', 'refusals never mutate the host-owned state');
});

test('confirm writes a validateApproval-clean approval bound to the pending candidate', async (t) => {
  const home = await tempHome(t);
  const { tool } = mount(home);
  const taskId = 'desktop-task-confirm-ok-1';
  const experimentId = 'experiment-confirm-ok-1';
  const sourceSha256 = candidateSourceDigest(PLAN.composition.code.host);
  const confirmationText = 'Yes, I explicitly approve promoting this candidate to acp.';
  await writeState(home, makeState(taskId, 'awaiting-owner-confirmation', {
    experimentId,
    candidateSourceSha256: sourceSha256,
    gates: { benefit: true, measured: true, repeatable: true },
    decision: { kind: 'promote', eligible: true, reasons: [] },
  }));

  const result = await tool.execute({
    action: 'confirm',
    taskId,
    experimentId,
    sourceSha256,
    confirmation: true,
    confirmationText,
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.action, 'confirm');
  assert.equal(result.taskId, taskId);
  assert.equal(result.approval.experimentId, experimentId);
  assert.equal(result.approval.sourceSha256, sourceSha256);
  assert.deepEqual(result.approval.targetProfiles, ['acp']);

  const approval = await readJson(path.join(taskChannelPaths(home).approvals, `${taskId}.json`));
  assert.deepEqual(validateApproval(approval), { ok: true, value: approval });
  assert.equal(approval.schemaVersion, SCHEMA_VERSION);
  assert.equal(approval.protocol, PROTOCOL_VERSION);
  assert.equal(approval.taskId, taskId);
  assert.equal(approval.experimentId, experimentId);
  assert.equal(approval.sourceSha256, sourceSha256);
  assert.equal(approval.confirmation, true);
  assert.equal(approval.confirmationText, confirmationText);
  assert.deepEqual(approval.targetProfiles, ['acp']);
  assert.equal(Number.isNaN(Date.parse(approval.confirmedAt)), false);

  const secondTaskId = 'desktop-task-confirm-ok-2';
  await writeState(home, makeState(secondTaskId, 'awaiting-owner-confirmation', {
    experimentId: 'experiment-confirm-ok-2',
    candidateSourceSha256: sourceSha256,
  }));
  const web = await tool.execute({
    action: 'confirm',
    taskId: secondTaskId,
    experimentId: 'experiment-confirm-ok-2',
    sourceSha256,
    confirmation: true,
    confirmationText,
    targetProfiles: ['web'],
  }, {});
  assert.equal(web.ok, true);
  assert.deepEqual(web.approval.targetProfiles, ['web']);
});

test('delegate rejects invalid plans and unknown actions without writing', async (t) => {
  const home = await tempHome(t);
  await writeReady(home);
  const { tool } = mount(home);

  const invalidPlan = await tool.execute({ action: 'delegate', plan: {}, taskId: 'desktop-task-invalid-1' }, {});
  assert.equal(invalidPlan.ok, false);
  assert.equal(invalidPlan.code, 'E_DESKTOP_TASK_INVALID');
  assert.ok(invalidPlan.message.length <= 500);
  assert.deepEqual(await listJsonFiles(taskChannelPaths(home).inbox), []);

  const unknown = await tool.execute({ action: 'bogus' }, {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'E_DESKTOP_ACTION_INVALID');
});

test('a malformed host-owned state becomes a bounded error, never an exception', async (t) => {
  const home = await tempHome(t);
  const taskId = 'desktop-task-malformed-1';
  const stateFile = path.join(taskChannelPaths(home).state, `${taskId}.json`);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, '{not json', 'utf8');

  const { tool } = mount(home);
  const result = await tool.execute({ action: 'status', taskId, waitMs: 0 }, {});

  assert.equal(result.ok, false);
  assert.equal(result.action, 'status');
  assert.equal(result.code, 'E_DESKTOP_TASK_STATE_INVALID');
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length <= 500);
  assert.equal(result.message.includes('\n'), false);
});

test('audit without a publication index reports no-action and writes nothing', async (t) => {
  const home = await tempHome(t);
  let launched = false;
  const { tool } = mount(home, {
    spawn: () => { launched = true; return { unref() {}, on() {} }; },
  });

  const result = await tool.execute({ action: 'audit' }, {});

  assert.equal(result.ok, true);
  assert.equal(result.action, 'audit');
  assert.equal(result.readOnly, true);
  assert.equal(typeof result.host, 'object');
  assert.equal(result.stable.status, 'absent');
  assert.equal(result.stable.reason, 'no published stable plugin');
  assert.deepEqual(result.stable.nextActions, []);
  assert.equal(result.experience.available, false);
  assert.equal(result.experience.none.reason, 'store-unavailable');
  assert.equal(result.selfEvolution.kind, 'no-action');
  assert.equal(result.selfEvolution.primary, 'none');
  assert.deepEqual(result.selfEvolution.nextActions, []);
  assert.equal(result.selfEvolution.readOnly, true);

  // The review is read-only: no inbox/state/approval document and no storage
  // directory may appear, and the Desktop application is never launched.
  assert.deepEqual(await fs.readdir(home), []);
  assert.equal(await pathExists(taskChannelPaths(home).root), false);
  assert.equal(await pathExists(path.join(home, 'storages')), false);
  assert.equal(launched, false);
});

test('audit classifies a stable plugin verified on another host as pending-revalidation', async (t) => {
  const home = await tempHome(t);
  const record = await writePublishedRecord(home);
  const services = liveHostServices();
  const calls = [];
  const { tool } = mount(home, {
    spawn: () => { throw new Error('audit must not launch the Desktop application'); },
    get: (serviceName) => {
      calls.push(serviceName);
      return services[serviceName] ?? null;
    },
  });
  // Pre-populate the whole Desktop channel with unrelated bytes: the audit
  // must leave every one of them untouched.
  const channel = taskChannelPaths(home);
  await fs.mkdir(channel.inbox, { recursive: true });
  await fs.mkdir(channel.state, { recursive: true });
  await fs.mkdir(channel.approvals, { recursive: true });
  await fs.writeFile(path.join(channel.inbox, 'desktop-task-existing-1.json'), '{"sentinel":"request"}\n');
  await fs.writeFile(path.join(channel.state, 'desktop-task-existing-1.json'), '{"sentinel":"state"}\n');
  await fs.writeFile(path.join(channel.approvals, 'desktop-task-existing-1.json'), '{"sentinel":"approval"}\n');
  const sharedPlugins = path.join(home, 'storages', 'evolution', 'shared-plugins');
  const before = await treeSnapshot(home);
  const sharedBefore = await treeSnapshot(sharedPlugins);
  const channelBefore = await treeSnapshot(channel.root);

  const result = await tool.execute({ action: 'audit' }, {});
  const after = await treeSnapshot(home);
  const sharedAfter = await treeSnapshot(sharedPlugins);

  assert.equal(result.ok, true);
  assert.equal(result.action, 'audit');
  assert.equal(result.readOnly, true);
  assert.equal(result.stable.status, 'pending-revalidation');
  assert.equal(result.stable.summary.pendingRevalidation, 1);
  assert.equal(result.stable.records.length, 1);
  assert.equal(result.stable.records[0].id, record.id);
  assert.equal(result.stable.records[0].status, 'pending-revalidation');
  assert.equal(result.stable.records[0].action, 'revalidate');
  assert.equal(result.stable.records[0].hostCompatible, false);
  assert.equal(result.stable.records[0].hostReason, 'host-version-mismatch');

  assert.equal(result.selfEvolution.kind, 'revalidate');
  assert.equal(result.selfEvolution.primary, 'revalidate');
  assert.equal(result.selfEvolution.hasBlockingStableIssue, true);
  assert.equal(result.selfEvolution.nextActions.length, 1);
  const revalidate = result.selfEvolution.nextActions[0];
  assert.equal(revalidate.action, 'revalidate');
  assert.equal(revalidate.recordId, record.id);
  assert.match(revalidate.why, /live host is a different release/);
  assert.match(revalidate.command, /shared-plugins\.mjs/);
  assert.match(revalidate.command, /revalidate --evidence/);
  assert.ok(revalidate.forbidden.includes('edit or regenerate the promoted plugin source'));
  assert.deepEqual(result.selfEvolution.versions, {
    dsh: LIVE_HOST_VERSIONS['@deepseek-ai/dsh'],
    cordis: LIVE_HOST_VERSIONS['@deepseek-ai/cordis'],
    evolution: evolutionPackageVersion(),
  });
  // The absent optional service does not stop stable-plugin classification.
  assert.equal(result.experience.available, false);
  assert.equal(result.experience.errors[0].errorCode, 'E_EVOLUTION_PLAN_NO_SHARED_STORE');

  // Reading the review leaves every byte on disk untouched: the entire
  // desktop-tasks channel and the shared-plugins index are byte-identical.
  assert.deepEqual(after, before);
  assert.deepEqual(sharedAfter, sharedBefore);
  assert.deepEqual(await treeSnapshot(channel.root), channelBefore);
  assert.equal(calls.filter((serviceName) => serviceName === 'evolutionExperience').length, 1);
});

test('audit obtains the shared experience store lazily and reports its absence honestly', async (t) => {
  const home = await tempHome(t);
  const calls = [];
  const services = liveHostServices();
  const { tool } = mount(home, {
    get: (serviceName) => {
      calls.push(serviceName);
      return services[serviceName] ?? null;
    },
  });
  // apply() must not resolve the optional service; only execute() may touch it.
  assert.equal(calls.includes('evolutionExperience'), false);

  const missing = await tool.execute({ action: 'audit' }, {});
  assert.equal(missing.ok, true);
  assert.equal(missing.experience.available, false);
  assert.equal(missing.experience.none.reason, 'store-unavailable');
  const storeError = missing.experience.errors.find((row) => row.errorCode === 'E_EVOLUTION_PLAN_NO_SHARED_STORE');
  assert.ok(storeError, 'the missing store is reported as a durable error, not as an empty history');
  assert.equal(storeError.reason, 'shared-experience-store-unavailable');
  assert.equal(missing.selfEvolution.experience.available, false);
  assert.equal(missing.selfEvolution.experience.errors[0].errorCode, 'E_EVOLUTION_PLAN_NO_SHARED_STORE');
  assert.equal(missing.selfEvolution.kind, 'no-action');
  assert.equal(calls.filter((serviceName) => serviceName === 'evolutionExperience').length, 1);

  const storeCalls = [];
  const storeServices = liveHostServices();
  const store = { discover: () => ({ records: [], truncated: false }) };
  const { tool: storeTool } = mount(home, {
    get: (serviceName) => {
      storeCalls.push(serviceName);
      if (serviceName === 'evolutionExperience') return { store };
      return storeServices[serviceName] ?? null;
    },
  });
  const present = await storeTool.execute({ action: 'audit', focus: 'timeout', minOccurrences: 5, limit: 2 }, {});
  assert.equal(present.ok, true);
  assert.equal(present.experience.available, true);
  assert.deepEqual(present.experience.errors, []);
  assert.equal(present.experience.none.reason, 'no-failure-signal');
  assert.equal(storeCalls.filter((serviceName) => serviceName === 'evolutionExperience').length, 1);
  assert.deepEqual(await fs.readdir(home), [], 'audit never creates the channel or approval files');
});

test('a review that cannot run is reported as a bounded audit failure, never as success', async (t) => {
  const home = await tempHome(t);
  const services = liveHostServices();
  const { tool } = mount(home, {
    get: (serviceName) => {
      if (serviceName === 'evolutionExperience') {
        return {
          get store() { throw new Error('service exploded at /Users/operator/private/path'); },
        };
      }
      return services[serviceName] ?? null;
    },
  });

  const result = await tool.execute({ action: 'audit' }, {});

  assert.equal(result.ok, false);
  assert.equal(result.action, 'audit');
  assert.equal(result.code, 'E_DESKTOP_AUDIT_FAILED');
  assert.match(result.message, /^Self-evolution audit unavailable/);
  assert.ok(result.message.length <= 500);
  assert.equal(result.message.includes('/Users/operator/private/path'), false);
  assert.deepEqual(await fs.readdir(home), []);
});
