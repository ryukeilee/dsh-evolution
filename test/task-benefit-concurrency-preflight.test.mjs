// R14: the producer runs the repetitions of one side concurrently, so a model
// bridge's turn list can no longer be sliced by length. These tests pin the
// per-session attribution contract and the bounded pilot-isolation preflight
// that refuses an unenforced pilot before the six paired sessions are spent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractSessionEvidence, planSessionWaves, produceTaskBenefit, selectSessionTurns } from '../scripts/acceptance/task-benefit.mjs';
import { runPilotIsolationPreflight } from '../scripts/acceptance/model-bridge.mjs';

function turn(sessionId, round, tool, filePath) {
  return {
    round,
    sessionId,
    ok: true,
    tools: ['read'],
    decision: tool === null
      ? { stop: true }
      : { tool, arguments: filePath === undefined ? {} : { file_path: filePath } },
    usage: { input: 10, output: 2, cache: { read: 0 } },
  };
}

function readUpdates(prefix, count) {
  const updates = [];
  for (let index = 0; index < count; index += 1) {
    updates.push({ sessionUpdate: 'tool_call', toolCallId: `${prefix}-${index}`, title: 'read' });
    updates.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: `${prefix}-${index}`,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: `<path>/work/a${index}.json</path>\n<content>sentinel-a</content>` } }],
    });
  }
  return updates;
}

test('concurrent bridge turns are attributed to the session that produced them', () => {
  // Interleaved as two concurrent sessions' requests would arrive: session 1
  // makes one tool call, session 2 makes two, and the records alternate.
  const turns = [
    turn('candidate-1', 0, 'read', '/work/a0.json'),
    turn('candidate-2', 0, 'read', '/work/a0.json'),
    turn('candidate-1', 1, null),
    turn('candidate-2', 1, 'read', '/work/a1.json'),
    turn('candidate-2', 2, null),
  ];
  const first = selectSessionTurns(turns, 'candidate-1');
  const second = selectSessionTurns(turns, 'candidate-2');
  assert.deepEqual(first.map((entry) => entry.round), [0, 1]);
  assert.deepEqual(second.map((entry) => entry.round), [0, 1, 2]);
  assert.deepEqual(selectSessionTurns(turns, 'baseline-1'), []);
  assert.deepEqual(selectSessionTurns(turns, undefined), []);

  const rowFor = (label, ownTurns, callCount) => extractSessionEvidence({
    label,
    side: 'candidate',
    turns: ownTurns,
    updates: readUpdates(label, callCount),
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    durationMs: 100,
  });
  // A length slice would have given the first session both sessions' turns.
  const firstRow = rowFor('candidate-1', first, 1);
  const secondRow = rowFor('candidate-2', second, 2);
  assert.equal(firstRow.turns, 2);
  assert.equal(firstRow.toolCalls, 1);
  assert.equal(secondRow.turns, 3);
  assert.equal(secondRow.toolCalls, 2);
  assert.equal(firstRow.attributionComplete, true);
  assert.equal(secondRow.attributionComplete, true);
});

test('the session planner keeps the serial rotation and groups parity for concurrency', () => {
  const serial = planSessionWaves({ runs: 3, concurrency: 2, serial: true });
  assert.deepEqual(serial.map((wave) => [wave.repetitions, wave.order[0]]), [
    [[0], 'candidate'],
    [[1], 'baseline'],
    [[2], 'candidate'],
  ]);
  // Two lanes: repetitions 1 and 3 (indices 0 and 2) share the candidate-first
  // wave, repetition 2 keeps its baseline-first order.
  const concurrent = planSessionWaves({ runs: 3, concurrency: 2, serial: false });
  assert.deepEqual(concurrent, [
    { repetitions: [0, 2], order: ['candidate', 'baseline'] },
    { repetitions: [1], order: ['baseline', 'candidate'] },
  ]);
  assert.deepEqual(concurrent.flatMap((wave) => wave.repetitions).sort(), [0, 1, 2]);
  // A wave never contains both sides: each side is one sequential list.
  for (const wave of concurrent) assert.deepEqual(wave.order, wave.repetitions[0] % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate']);
  assert.deepEqual(planSessionWaves({ runs: 5, concurrency: 5, serial: false }).map((wave) => wave.repetitions), [[0, 2, 4], [1, 3]]);
});

test('the isolation preflight refuses a pilot that used its own tools', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-preflight-bypass-'));
  try {
    const result = await runPilotIsolationPreflight({
      cwd,
      runner: async () => ({ ok: true, ownToolCalls: 2, ownToolNames: ['read', 'bash'], text: 'done', usage: null, wallMs: 1 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_ACP_PILOT_ISOLATION_BYPASS');
    assert.equal(result.reason, 'pilot-used-own-tools');
    assert.deepEqual(result.ownToolNames, ['read', 'bash']);
    // The contract is a bounded refusal: one turn, far below one session.
    assert.ok(Number.isInteger(result.wallMs) && result.wallMs <= 20_000, `preflight wall ${result.wallMs} ms`);
    // The probe proves the same config the sessions run under.
    const config = JSON.parse(await fs.readFile(path.join(cwd, 'opencode.json'), 'utf8'));
    const actions = config.agents.build.permissions.map((rule) => rule.action);
    for (const action of ['*', 'read', 'bash', 'skill']) assert.ok(actions.includes(action), `missing deny rule for ${action}`);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('the isolation preflight passes a turn with no own-tool evidence', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-preflight-pass-'));
  try {
    let seenEnv = null;
    const result = await runPilotIsolationPreflight({
      cwd,
      runner: async (prompt, options) => {
        seenEnv = options?.env ?? null;
        return { ok: true, ownToolCalls: 0, ownToolNames: [], text: 'DSH_PILOT_NO_TOOLS', usage: { input: 1, output: 1 }, wallMs: 1 };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(Number.isInteger(result.wallMs));
    // The probe turn runs under the same process-local isolation layer as the
    // measured sessions.
    assert.ok(seenEnv && typeof seenEnv.OPENCODE_CONFIG_CONTENT === 'string');
    const rules = JSON.parse(seenEnv.OPENCODE_CONFIG_CONTENT).agents.build.permissions;
    assert.ok(rules.some((rule) => rule.action === 'read' && rule.effect === 'deny'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('the isolation preflight treats an instruction-only skill call as non-capability', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-preflight-skill-'));
  try {
    const result = await runPilotIsolationPreflight({
      cwd,
      runner: async () => ({ ok: true, ownToolCalls: 1, ownToolNames: ['skill'], text: 'skill loaded', usage: { input: 1, output: 1 }, wallMs: 1 }),
    });
    assert.equal(result.ok, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('the isolation preflight retries one transport failure and can still pass', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-preflight-retry-'));
  try {
    let calls = 0;
    const result = await runPilotIsolationPreflight({
      cwd,
      runner: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, reason: 'model-process-failed', wallMs: 1 };
        return { ok: true, ownToolCalls: 0, ownToolNames: [], text: 'DSH_PILOT_NO_TOOLS', usage: { input: 1, output: 1 }, wallMs: 1 };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('the isolation preflight reports a transport failure with a fixed code', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-preflight-failed-'));
  try {
    const result = await runPilotIsolationPreflight({
      cwd,
      runner: async () => ({ ok: false, reason: 'model-process-failed', wallMs: 2 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_ACP_PILOT_PREFLIGHT_FAILED');
    assert.equal(result.reason, 'model-process-failed');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('a preflight bypass refuses the producer before any session and writes no artifact', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'r14-producer-refusal-'));
  const taskId = 'r14-preflight-refusal';
  try {
    await assert.rejects(
      produceTaskBenefit({
        home,
        taskId,
        task: { id: 'read-one-sentinel', prompt: 'read a.json and report the sentinel', expect: 'sentinel-a' },
        candidateHost: 'return { name: "unused-preview" };',
        host: { dsh: '0.0.0-test', cordis: '0.0.0-test' },
        cli: path.join(home, 'missing-dsh'),
        preflightRunner: async () => ({ ok: true, ownToolCalls: 1, ownToolNames: ['bash'], text: 'ran it', usage: null, wallMs: 1 }),
      }),
      (error) => {
        assert.equal(error.code, 'E_ACP_PILOT_ISOLATION_BYPASS');
        assert.equal(error.reason, 'pilot-used-own-tools');
        return true;
      },
    );
    const artifact = path.join(home, 'storages', 'evolution', 'desktop-tasks', 'task-evidence', `${taskId}.json`);
    await assert.rejects(fs.access(artifact), /ENOENT/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
