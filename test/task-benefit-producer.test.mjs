// The taskBenefit producer is the only path that can turn a real paired run
// into evidence the promotion gate accepts. These tests pin its pure contract
// (correctness, exercise, aggregation, binding) and the negative shapes that
// must stay rejected; they do not call a real model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  aggregateSessions,
  answerMatches,
  assertIsolatedHome,
  buildTaskBenefitArtifact,
  extractSessionEvidence,
  normalizeTask,
  parseExpectTokens,
  writePreviewModule,
} from '../scripts/acceptance/task-benefit.mjs';
import { validateTaskBenefit } from '../lib/orchestrator.js';

const TOKENS = ['sentinel-a', 'sentinel-b', 'sentinel-c'];

function sessionRow({ side, turns, toolCalls, tokens, durationMs, correct = true, exercised = true, usedCandidate = false }) {
  return {
    label: side + '-1', side, correct, exercised, usedCandidate,
    turns, toolCalls, toolNames: [], failures: 0,
    tokens, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0,
    durationMs, readResultCount: exercised ? 1 : 0, readResultCharacters: exercised ? 3000 : 0,
  };
}

function turnsWith(tools) {
  return tools.map((name, index) => ({
    ok: true,
    tools: ['read', 'bash', 'glob'],
    decision: name === null ? { stop: true } : { tool: name, arguments: {} },
    usage: { input: 1000 + index * 100, output: 10, cache: { read: 50 } },
    round: index,
  }));
}

test('the task definition and expected values are bounded before any session runs', () => {
  assert.deepEqual(parseExpectTokens('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseExpectTokens('sentinel-one'), ['sentinel-one']);
  assert.deepEqual(parseExpectTokens('[broken'), ['[broken']);
  const task = normalizeTask({ id: 'read-long-line', prompt: 'read it', expect: '["sentinel-a","sentinel-b"]' });
  assert.deepEqual(task.tokens, ['sentinel-a', 'sentinel-b']);
  assert.throws(() => normalizeTask({ id: 'has space', prompt: 'p', expect: 'e' }), /task\.id/);
  assert.throws(() => normalizeTask({ id: 'ok', prompt: '', expect: 'e' }), /task\.prompt/);
  assert.equal(answerMatches('values: sentinel-a and sentinel-b', ['sentinel-a', 'sentinel-b']), true);
  assert.equal(answerMatches('values: sentinel-a', ['sentinel-a', 'sentinel-b']), false);
});

test('a session row counts only decision turns and proves the policy was exercised by a read result', () => {
  const turns = turnsWith(['read', 'bash', null]);
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
    { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'bash' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [{ type: 'content', content: { type: 'text', text: '<content>sentinel-a sentinel-b sentinel-c</content>' } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c2', content: [{ type: 'content', content: { type: 'text', text: 'shell output' } }] },
  ];
  const row = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns, updates,
    assistantText: 'a=sentinel-a b=sentinel-b c=sentinel-c',
    expectedTokens: TOKENS, candidateTool: null, durationMs: 1234,
  });
  // The bridge records the live tool surface on every decision request, so the
  // final stop turn is a model turn too; only turns that chose a tool count as
  // tool calls.
  assert.equal(row.turns, 3);
  assert.equal(row.toolCalls, 2);
  assert.deepEqual(row.toolNames, ['read', 'bash']);
  assert.equal(row.tokens, (1000 + 1100 + 1200) + (10 * 3) + (50 * 3));
  assert.equal(row.correct, true);
  assert.equal(row.exercised, true);
  assert.equal(row.usedCandidate, false);
});

test('a read result without the expected value is not proof that the policy ran', () => {
  const turns = turnsWith(['read', null]);
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [{ type: 'content', content: { type: 'text', text: 'line truncated to 2000 chars' } }] },
  ];
  const row = extractSessionEvidence({
    label: 'candidate-2', side: 'candidate', turns, updates,
    assistantText: 'sentinel-a sentinel-b sentinel-c',
    expectedTokens: TOKENS, candidateTool: null, durationMs: 10,
  });
  assert.equal(row.exercised, false);
  assert.equal(row.correct, true);
});

test('missing usage and failed tool results are measured instead of rounded to zero', () => {
  const turns = turnsWith(['read', null]);
  turns[0].usage = undefined;
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
    { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'bash' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'sentinel-a' } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed', content: [] },
  ];
  const row = extractSessionEvidence({
    label: 'candidate-3', side: 'candidate', turns, updates,
    assistantText: 'sentinel-a sentinel-b sentinel-c',
    expectedTokens: TOKENS, candidateTool: null, durationMs: 10,
  });
  assert.equal(row.usageComplete, false, 'a decision without usage cannot be counted as a zero-cost turn');
  assert.equal(row.toolFailures, 2);
  assert.equal(row.failures, 2);
  assert.equal(row.exercised, false, 'a failed read result is not proof that the policy ran');
});

test('aggregation sums measured sessions and counts failed ones', () => {
  const rows = [
    sessionRow({ side: 'baseline', turns: 9, toolCalls: 6, tokens: 10000, durationMs: 30000 }),
    { ...sessionRow({ side: 'baseline', turns: 9, toolCalls: 6, tokens: 10000, durationMs: 30000 }), failures: 1 },
  ];
  const summary = aggregateSessions(rows);
  assert.deepEqual(summary, { sessions: 2, correct: 2, failures: 1, turns: 18, toolCalls: 12, tokens: 20000, durationMs: 60000 });
});

test('a produced artifact satisfies the real taskBenefit validator and its negatives stay rejected', () => {
  const task = normalizeTask({ id: 'read-long-line', prompt: 'read a.json b.json c.json', expect: JSON.stringify(TOKENS) });
  const host = 'return { name: "complete-line", inject: ["tools"], apply(ctx) {} };';
  const artifact = buildTaskBenefitArtifact({
    taskId: 'task-abc',
    task,
    candidateHost: host,
    model: 'opencode-go/deepseek-v4.1-flash',
    host: { dsh: '0.2.2-rc.3', cordis: '4.1.0' },
    runs: 3,
    baseline: Array.from({ length: 3 }, () => sessionRow({ side: 'baseline', turns: 9, toolCalls: 6, tokens: 30000, durationMs: 30000 })),
    candidate: Array.from({ length: 3 }, () => sessionRow({ side: 'candidate', turns: 6, toolCalls: 3, tokens: 20000, durationMs: 20000 })),
    adoption: { sessionsUsingCandidate: 0, sessionsExercised: 3 },
  });
  assert.equal(Object.hasOwn(artifact, 'sessions'), false, 'raw sessions must not ride in the channel artifact');
  const binding = { hostSha256: artifact.candidateHostSha256, taskId: 'task-abc', improvement: 'context-policy', applicability: { dsh: '0.2.2-rc.3', cordis: '4.1.0' } };
  const accepted = validateTaskBenefit(artifact, binding);
  assert.equal(accepted.ok, true, accepted.issues.join('; '));
  assert.equal(accepted.benefit, true);

  const noGain = validateTaskBenefit({
    ...artifact,
    candidate: { ...artifact.candidate, turns: artifact.baseline.turns, toolCalls: artifact.baseline.toolCalls },
  }, binding);
  assert.equal(noGain.benefit, false);
  assert.match(noGain.artifact.issues.join(' '), /did not reduce turns or tool calls/);

  const unused = validateTaskBenefit({ ...artifact, adoption: { sessionsUsingCandidate: 0, sessionsExercised: 0 } }, binding);
  assert.equal(unused.benefit, false);
  assert.match(unused.artifact.issues.join(' '), /never transformed a step/);

  const wrongSource = validateTaskBenefit({ ...artifact, candidateHostSha256: 'd'.repeat(64) }, binding);
  assert.equal(wrongSource.ok, false);
  assert.match(wrongSource.issues.join(' '), /does not match the Trial candidate source/);

  const regression = validateTaskBenefit({
    ...artifact,
    candidate: { ...artifact.candidate, tokens: 200000 },
  }, binding);
  assert.equal(regression.benefit, false);
  assert.match(regression.artifact.issues.join(' '), /regressed failures, tokens or wall time/);
});

test('the producer refuses the formal DSH_HOME and non-temporary roots', () => {
  assert.throws(() => assertIsolatedHome(path.join(os.homedir(), '.dsh')), /formal DSH_HOME/);
  assert.throws(() => assertIsolatedHome(path.join(os.homedir(), 'work', 'home')), /temporary directory/);
  assert.equal(assertIsolatedHome(path.join(os.tmpdir(), 'isolated-home')), path.join(realpathSync(os.tmpdir()), 'isolated-home'));
  // macOS os.tmpdir() and /tmp name the same temporary world; the acceptance
  // work directory is commonly created under /tmp.
  assert.equal(assertIsolatedHome('/tmp/task-benefit-home'), path.join(realpathSync('/tmp'), 'task-benefit-home'));
});

test('a temporary symlink into the formal home is rejected before any write', async () => {
  const formal = path.join(os.homedir(), '.dsh');
  if (!existsSync(formal)) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-symlink-'));
  try {
    const link = path.join(root, 'home');
    await fs.symlink(formal, link);
    assert.throws(() => assertIsolatedHome(link), /formal DSH_HOME/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the preview wrapper mounts the exact Host body through an ESM plugin', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-wrapper-'));
  try {
    const file = path.join(root, 'preview.mjs');
    await writePreviewModule(file, 'return { name: "preview", inject: ["tools"], apply(ctx) { ctx.ran = true; } };');
    const module = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    assert.equal(module.name, 'preview');
    assert.deepEqual(module.inject, ['tools']);
    const ctx = {};
    module.apply(ctx, {});
    assert.equal(ctx.ran, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
