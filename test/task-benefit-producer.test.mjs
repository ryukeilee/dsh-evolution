// The taskBenefit producer is the only path that can turn a real paired run
// into evidence the promotion gate accepts. These tests pin its pure contract
// (correctness, exercise, aggregation, binding) and the negative shapes that
// must stay rejected; they do not call a real model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  aggregateSessions,
  answerMatches,
  assertIsolatedHome,
  assertReadBinding,
  assertIsolatedStorageRoots,
  assertIsolatedTarget,
  assertReportOutsideEvidence,
  assertResolvedArtifactTarget,
  buildTaskBenefitArtifact,
  extractSessionEvidence,
  inspectArtifactTarget,
  normalizeTask,
  parseExpectTokens,
  pilotFailureReasons,
  pilotTransportRetryable,
  prepareArtifactDirectory,
  readPathMatches,
  retryableSession,
  resolveArtifactTarget,
  resolveFilesystemPath,
  safeErrorCode,
  successfulToolResult,
  toolCallDescriptor,
  writeArtifactFile,
  writePreviewModule,
  writeReportFile,
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
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<path>/work/a.json</path>\n<content>sentinel-a sentinel-b sentinel-c</content>' } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'shell output' } }] },
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

test('a follow-up read of the same file cannot stand in for the policy effect', () => {
  const turns = turnsWith(['read', 'read', null]);
  const call = (id) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'read' });
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  // Baseline shape: the capped first window lacks the sentinel, and the model
  // recovers with a second read of the same path that carries it.
  const split = extractSessionEvidence({
    label: 'baseline-1', side: 'baseline', turns,
    updates: [
      call('c1'), call('c2'),
      result('c1', '<path>/home/a.json</path>\n<content>\nfirst window\n(Output capped. Showing lines 1-37. Use offset=38 to continue.)\n</content>'),
      result('c2', '<path>/home/a.json</path>\n<content>\nsentinel-a\n(End of file - total 42 lines)\n</content>'),
    ],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 5,
  });
  assert.equal(split.correct, true);
  assert.equal(split.exercised, false, 'the recover-by-reread path is not the policy completing the first read');
  // Candidate shape: the first window already carries the value.
  const whole = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns: turnsWith(['read', null]),
    updates: [
      call('c1'),
      result('c1', '<path>/home/a.json</path>\n<content>\nfirst window\nsentinel-a\n(End of file - total 42 lines)\n</content>'),
    ],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 5,
  });
  assert.equal(whole.exercised, true);
});

test('a first read that jumps to the tail or has no identifiable path is not mechanism proof', () => {
  const call = { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' };
  const result = (text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  const baseTurn = turnsWith(['read', 'read'])[0];
  const second = { ...turnsWith(['read', 'read'])[1], decision: { tool: 'read', arguments: { file_path: '/work/a.json' } } };
  const turns = [{ ...baseTurn, decision: { tool: 'read', arguments: { file_path: '/work/a.json', offset: 600 } } }, second];
  const tail = extractSessionEvidence({
    label: 'candidate-tail', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<path>/work/a.json</path>\n<content>tail</content>' } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<path>/work/a.json</path>\n<content>sentinel-a</content>' } }] },
    ],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 1,
  });
  assert.equal(tail.exercised, false, 'a start reread after a tail-first read does not prove the policy completed the start window');

  const failedTail = extractSessionEvidence({
    label: 'candidate-failed-tail', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'read failed' } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<path>/work/a.json</path>\n<content>sentinel-a</content>' } }] },
    ],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 1,
  });
  assert.equal(failedTail.exercised, false, 'a failed first request cannot be replaced by a later start read');

  const start = extractSessionEvidence({
    label: 'candidate-start', side: 'candidate',
    turns: [{ ...turns[0], decision: { tool: 'read', arguments: { file_path: '/work/a.json' } } }],
    updates: [call, result('<path>/work/a.json</path>\n<content>sentinel-a</content>')],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 1,
  });
  assert.equal(start.exercised, true);

  const noPath = extractSessionEvidence({
    label: 'candidate-nopath', side: 'candidate',
    turns: [{ ...turns[0], decision: { tool: 'read', arguments: {} } }],
    updates: [call, result('<content>sentinel-a</content>')],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 1,
  });
  assert.equal(noPath.exercised, false, 'a result with no identifiable path cannot be deduplicated');
});

test('a value read from another file cannot prove the mechanism ran', () => {
  const paths = ['/home/a.txt', '/home/b.txt', '/home/c.txt'];
  const turns = ['read', 'read', 'read'].map((tool, index) => ({
    ok: true,
    tools: ['read', 'bash'],
    decision: { tool, arguments: { file_path: paths[index] } },
    usage: { input: 1000, output: 10, cache: { read: 50 } },
    round: index,
  }));
  const calls = paths.map((_, index) => ({ sessionUpdate: 'tool_call', toolCallId: 'c' + (index + 1), title: 'read', rawInput: { file_path: paths[index] } }));
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  // a's first read wrongly carries b's sentinel; b's own first read does not.
  const updates = [
    ...calls,
    result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a sentinel-b</content>'),
    result('c2', '<path>/home/b.txt</path>\n<content>no value here</content>'),
    result('c3', '<path>/home/c.txt</path>\n<content>sentinel-c</content>'),
  ];
  const expectedReads = [
    { path: '/home/a.txt', token: 'sentinel-a' },
    { path: '/home/b.txt', token: 'sentinel-b' },
    { path: '/home/c.txt', token: 'sentinel-c' },
  ];
  const bound = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns, updates,
    assistantText: 'sentinel-a sentinel-b sentinel-c',
    expectedTokens: TOKENS, expectedReads, candidateTool: null, durationMs: 1,
  });
  assert.equal(bound.correct, true);
  assert.equal(bound.exercised, false, "b's sentinel was delivered by a's read, not by b's first read");
  // The same shape without a per-file binding is what the earlier check
  // accepted; keep this assertion so the reason for the binding stays visible.
  const unbound = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns, updates,
    assistantText: 'sentinel-a sentinel-b sentinel-c',
    expectedTokens: TOKENS, candidateTool: null, durationMs: 1,
  });
  assert.equal(unbound.exercised, true);

  // The bound check still passes when each file's own first read carries its
  // own value.
  const complete = updates.map((update, index) => index < 3 ? update
    : result('c' + (index - 2), '<path>' + paths[index - 3] + '</path>\n<content>' + TOKENS[index - 3] + '</content>'));
  const boundComplete = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns, updates: complete,
    assistantText: 'sentinel-a sentinel-b sentinel-c',
    expectedTokens: TOKENS, expectedReads, candidateTool: null, durationMs: 1,
  });
  assert.equal(boundComplete.exercised, true);
});

test('ACP rawInput and result path decide attribution, not the decision order', () => {
  const turns = ['read', 'read'].map((tool, index) => ({
    ok: true,
    tools: ['read'],
    decision: { tool, arguments: { file_path: index === 0 ? '/home/a.txt' : '/home/b.txt' } },
    usage: { input: 1, output: 1, cache: { read: 0 } },
    round: index,
  }));
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  // The model said a then b, but ACP reports the executed calls as b then a.
  const reordered = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: { file_path: '/home/b.txt' } },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read', rawInput: { file_path: '/home/a.txt' } },
      result('c1', '<path>/home/b.txt</path>\n<content>sentinel-b</content>'),
      result('c2', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a sentinel-b',
    expectedTokens: ['sentinel-a', 'sentinel-b'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }, { path: '/home/b.txt', token: 'sentinel-b' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(reordered.exercised, true, 'the executed call input and result path win over the decision order');

  // A request for a that returns b's path is not proof for either file.
  const conflicting = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: [{ ...turns[0], decision: { tool: 'read', arguments: { file_path: '/home/a.txt' } } }],
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: { file_path: '/home/a.txt' } },
      result('c1', '<path>/home/b.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(conflicting.exercised, false, 'a result path that disagrees with the request cannot prove a read');
});

test('a reordered bash/read reply cannot make bash output count as a read', () => {
  const turns = [
    { ok: true, tools: ['read', 'bash'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt' } }, usage: { input: 1, output: 1 }, round: 0 },
    { ok: true, tools: ['read', 'bash'], decision: { tool: 'bash', arguments: { command: 'cat a.txt' } }, usage: { input: 1, output: 1 }, round: 1 },
  ];
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  // ACP reports bash first and read second, the opposite of the decisions.
  const row = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'bash', rawInput: { command: 'cat a.txt' } },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read', rawInput: { file_path: '/home/a.txt' } },
      result('c1', 'sentinel-a\n'),
      result('c2', '<path>/home/a.txt</path>\n<content>first window</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(row.exercised, false, 'the value came from bash, not from the first read');
});

test('same-name calls without rawInput and descriptive titles cannot borrow an offset', () => {
  const turns = [
    { ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt', offset: 1 } }, usage: { input: 1, output: 1 }, round: 0 },
    { ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt', offset: 600 } }, usage: { input: 1, output: 1 }, round: 1 },
  ];
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  // Transport order is the tail read first, but both calls are named read and
  // carry no rawInput: position cannot prove which offset belongs to which id.
  const ambiguous = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read' },
      result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
      result('c2', '<path>/home/a.txt</path>\n<content>first window</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(ambiguous.exercised, false);

  const descriptive = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: [{ ...turns[0] }],
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read the config file' },
      result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(descriptive.exercised, false, 'a descriptive title is not a tool identity');
});

test('a missing title or an unidentified first call blocks first-read attribution', () => {
  const turns = [
    { ok: true, tools: ['read', 'bash'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt' } }, usage: { input: 1, output: 1 }, round: 0 },
    { ok: true, tools: ['read', 'bash'], decision: { tool: 'bash', arguments: { command: 'cat a.txt' } }, usage: { input: 1, output: 1 }, round: 1 },
  ];
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  const noTitle = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2' },
      result('c1', 'sentinel-a\n'),
      result('c2', '<path>/home/a.txt</path>\n<content>first window</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(noTitle.exercised, false, 'a title is required to name the executed tool');

  // The first (tail) read has a descriptive title and cannot be identified; a
  // later start read must not replace it as the first read.
  const descriptiveFirst = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: [
      { ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt', offset: 600 } }, usage: { input: 1, output: 1 }, round: 0 },
      { ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt' } }, usage: { input: 1, output: 1 }, round: 1 },
    ],
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read the config' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read', rawInput: { file_path: '/home/a.txt' } },
      result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
      result('c2', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(descriptiveFirst.exercised, false);
});

test('a pathless first read or a duplicate call id blocks first-read attribution', () => {
  const turns = [
    { ok: true, tools: ['read'], decision: { tool: 'read', arguments: {} }, usage: { input: 1, output: 1 }, round: 0 },
    { ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt' } }, usage: { input: 1, output: 1 }, round: 1 },
  ];
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  const pathless = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read', rawInput: { file_path: '/home/a.txt' } },
      result('c1', 'a tail with no path'),
      result('c2', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(pathless.exercised, false, 'a pathless first read cannot be replaced by a later start read');

  const duplicate = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: [{ ...turns[1] }],
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: { file_path: '/home/a.txt', offset: 600 } },
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: { file_path: '/home/a.txt' } },
      result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(duplicate.exercised, false, 'a duplicate call id cannot be joined unambiguously');
});

test('tool adoption and call counts come from verified ACP calls, not decisions', () => {
  const row = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: [{ ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt' } }, usage: { input: 1, output: 1 }, round: 0 }],
    updates: [{ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read the config file' }],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: 'read', durationMs: 1,
  });
  assert.equal(row.attributionComplete, false);
  assert.equal(row.usedCandidate, false, 'an unverified decision is not tool adoption');
  assert.equal(row.toolCalls, 0);
});

test('a call/decision count mismatch is not attributed to the policy', () => {
  const turns = turnsWith(['read', 'read']).map((turn, index) => ({
    ...turn,
    decision: { tool: 'read', arguments: { file_path: index === 0 ? '/work/a.txt' : '/work/b.txt' } },
  }));
  const update = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  const row = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: { file_path: '/work/a.txt' } },
      update('c1', '<path>/work/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 1,
  });
  assert.equal(row.toolCalls, 1);
  assert.equal(row.attributionComplete, false, 'two tool decisions but one call is an incomplete sample');
  assert.equal(row.exercised, false, 'two decisions but one reported call cannot be joined by position');
});

test('read path binding accepts relative/canonical aliases but not a different path', () => {
  assert.equal(readPathMatches('/iso/home/a.txt', '/iso/home/a.txt', '/iso/home'), true);
  assert.equal(readPathMatches('a.txt', '/iso/home/a.txt', '/iso/home'), true);
  assert.equal(readPathMatches('./a.txt', '/iso/home/a.txt', '/iso/home'), true);
  assert.equal(readPathMatches('sub/a.txt', '/iso/home/sub/a.txt', '/iso/home'), true);
  assert.equal(readPathMatches('/iso/home/a.txt', '/iso/home/b.txt', '/iso/home'), false);
  assert.equal(readPathMatches('/iso/home/sub/a.txt', '/iso/home/a.txt', '/iso/home'), false);
  assert.equal(readPathMatches('a.txt', '/iso/home/sub/a.txt', '/iso/home'), false);
});

test('only a pilot transport failure can replace a whole session', () => {
  assert.equal(pilotTransportRetryable([{ ok: false, reason: 'decision-shape-invalid' }]), true);
  assert.equal(pilotTransportRetryable([{ ok: false, reason: 'model-process-failed' }]), true);
  assert.equal(pilotTransportRetryable([{ ok: false, reason: 'pilot-used-own-tools' }]), false);
  assert.equal(pilotTransportRetryable([{ ok: false, reason: 'pilot-used-own-tools' }, { ok: false, reason: 'reply-has-no-object' }]), false);
  assert.equal(pilotTransportRetryable([{ ok: false }]), false);
  assert.equal(pilotTransportRetryable([]), false);
  // A product tool failure is never hidden by a retry, even when a pilot turn
  // also failed with a retryable reason.
  assert.equal(retryableSession({ toolFailures: 1, retryableTransportFailure: true }), false);
  assert.equal(retryableSession({ toolFailures: 0, retryableTransportFailure: true }), true);
  assert.equal(retryableSession({ toolFailures: 0, retryableTransportFailure: false }), false);
});

test('persisted pilot failure reasons are fixed codes, not raw exception text', () => {
  assert.deepEqual(pilotFailureReasons([{ ok: false, reason: 'decision-shape-invalid' }]), ['decision-shape-invalid']);
  assert.deepEqual(pilotFailureReasons([{ ok: false, reason: 'pilot-used-own-tools' }]), ['pilot-used-own-tools']);
  assert.deepEqual(pilotFailureReasons([{ ok: false, reason: 'Unexpected token < in JSON: {"private":"body"}' }]), ['pilot-transport-error']);
  assert.deepEqual(pilotFailureReasons([{ ok: true, reason: 'whatever' }]), []);
});

test('a completed result marked as an error is not a successful read', () => {
  assert.equal(successfulToolResult({ status: 'completed' }), true);
  assert.equal(successfulToolResult({ status: 'success' }), true);
  assert.equal(successfulToolResult({ status: 'completed', isError: true }), false);
  assert.equal(successfulToolResult({ status: 'completed', is_error: true }), false);
  assert.equal(successfulToolResult({ status: 'in_progress' }), false);
});

test('a failed initial tool_call is a host tool failure even without an update', () => {
  const row = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: turnsWith(['read', 'read']),
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', status: 'failed' },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'read', status: 'failed' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed' },
      { sessionUpdate: 'tool_call', toolCallId: 'c1', status: 'failed' },
    ],
    assistantText: 'no value', expectedTokens: ['sentinel-a'], candidateTool: null, durationMs: 1,
  });
  assert.equal(row.toolFailures, 2, 'the same failed call id is counted once, and both notifications are merged');
});

test('multi-file context-policy evidence requires a complete read mapping', () => {
  const task = normalizeTask({ id: 'read-files', prompt: 'read a and b', expect: '["sentinel-a","sentinel-b"]' });
  assert.throws(() => assertReadBinding('context-policy', task), /task\.reads/);
  assert.doesNotThrow(() => assertReadBinding('context-policy', { ...task, reads: [
    { path: '/home/a.txt', token: 'sentinel-a' }, { path: '/home/b.txt', token: 'sentinel-b' },
  ] }));
  assert.doesNotThrow(() => assertReadBinding('tool', task));
});

test('an empty rawInput cannot erase an explicit offset from a unique decision', () => {
  const turns = [
    { ok: true, tools: ['read'], decision: { tool: 'read', arguments: { file_path: '/home/a.txt', offset: 600 } }, usage: { input: 1, output: 1 }, round: 0 },
  ];
  const result = (id, text) => ({
    sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  const tail = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate', turns,
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: {} },
      result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(tail.exercised, false, 'the tail read must keep its explicit offset');

  const start = extractSessionEvidence({
    label: 'candidate-1', side: 'candidate',
    turns: [{ ...turns[0], decision: { tool: 'read', arguments: { file_path: '/home/a.txt', offset: 1 } } }],
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read', rawInput: {} },
      result('c1', '<path>/home/a.txt</path>\n<content>sentinel-a</content>'),
    ],
    assistantText: 'sentinel-a',
    expectedTokens: ['sentinel-a'],
    expectedReads: [{ path: '/home/a.txt', token: 'sentinel-a' }],
    candidateTool: null, durationMs: 1,
  });
  assert.equal(start.exercised, true);
});

test('a per-file binding must cover every expected token', () => {
  const base = { id: 'read-files', prompt: 'read a and b', expect: '["sentinel-a","sentinel-b"]' };
  const task = normalizeTask({ ...base, reads: [{ path: '/iso/home/a.txt', token: 'sentinel-a' }, { path: '/iso/home/b.txt', token: 'sentinel-b' }] });
  assert.deepEqual(task.reads, [{ path: '/iso/home/a.txt', token: 'sentinel-a' }, { path: '/iso/home/b.txt', token: 'sentinel-b' }]);
  assert.throws(() => normalizeTask({ ...base, reads: [{ path: '/iso/home/a.txt', token: 'sentinel-a' }] }), /every expected token/);
  assert.throws(() => normalizeTask({ ...base, reads: [{ path: '/iso/home/a.txt', token: 'other' }, { path: '/iso/home/b.txt', token: 'sentinel-b' }] }), /not declared/);
  assert.throws(() => normalizeTask({ ...base, reads: [{ path: 'a.txt', token: 'sentinel-a' }, { path: '/iso/home/b.txt', token: 'sentinel-b' }] }), /absolute/);
});

test('a read result without the expected value is not proof that the policy ran', () => {
  const turns = turnsWith(['read', null]);
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'line truncated to 2000 chars' } }] },
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

test('invalid billing fields and in-progress reads are not evidence', () => {
  for (const usage of [{ input: null, output: 1, cache: { read: 2 } }, { input: 1, output: 1, cache: { read: 'x' } }, {}]) {
    const turns = turnsWith(['read', null]);
    turns[0].usage = usage;
    const row = extractSessionEvidence({
      label: 'candidate-4', side: 'candidate', turns, updates: [],
      assistantText: 'sentinel-a sentinel-b sentinel-c', expectedTokens: TOKENS, candidateTool: null, durationMs: 1,
    });
    assert.equal(row.usageComplete, false, 'invalid usage must not be treated as zero: ' + JSON.stringify(usage));
    assert.equal(row.tokens, 0);
  }
  const turns = turnsWith(['read', null]);
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'read' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'sentinel-a sentinel-b sentinel-c' } }] },
  ];
  const row = extractSessionEvidence({
    label: 'candidate-5', side: 'candidate', turns, updates,
    assistantText: 'sentinel-a sentinel-b sentinel-c', expectedTokens: TOKENS, candidateTool: null, durationMs: 1,
  });
  assert.equal(row.exercised, false, 'an in-progress read cannot prove that the policy ran');
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
    assert.throws(() => assertIsolatedHome(path.join(link, 'new', 'nested')), /formal DSH_HOME/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('producer work and artifact targets cannot escape the verified home', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-home-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-outside-')));
  try {
    assert.equal(await assertIsolatedTarget(path.join(home, 'work'), home, 'work'), path.join(home, 'work'));
    await fs.symlink(outside, path.join(home, 'link'));
    await assert.rejects(assertIsolatedTarget(path.join(home, 'link', 'nested'), home, 'work'), /isolated home/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('the artifact target stays in the isolated home unless an operator designates a channel root', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-target-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-target-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-target-outside-')));
  try {
    const segments = ['storages', 'evolution', 'desktop-tasks', 'task-evidence', 'desktop-task-proof.json'];
    const inside = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof' });
    assert.equal(inside.channel, null);
    assert.equal(inside.outFile, path.join(home, ...segments));

    const delivered = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    assert.equal(delivered.channel, channel);
    assert.equal(delivered.outFile, path.join(channel, ...segments));
    // A designated channel may itself be a symlink; the artifact follows its canonical root.
    const link = path.join(outside, 'channel-link');
    await fs.symlink(channel, link);
    assert.equal((await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: link })).outFile, delivered.outFile);

    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: 'relative/channel' }), /absolute channel root/);
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: path.join(channel, 'missing') }), /existing directory/);
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: home }), /must not be the isolated home/);
    await fs.mkdir(path.join(home, 'channel'));
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: path.join(home, 'channel') }), /must not be the isolated home/);
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel, outFile: path.join(home, 'a.json') }), /two different artifact authorities/);
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'has space', channelHome: channel }), /task identity rule/);
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', outFile: path.join(outside, 'a.json') }), /isolated home/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('the designated channel receives one atomic 0600 artifact and no temporary file', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-write-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-write-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-write-outside-')));
  try {
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    await inspectArtifactTarget(target);
    // The preflight only reads: it must not create the artifact directory.
    assert.equal(await fs.stat(path.dirname(target.outFile)).catch(() => null), null);
    const parent = await prepareArtifactDirectory(target);
    assert.equal(parent, path.dirname(target.outFile));
    assert.equal(await fs.stat(target.outFile).catch(() => null), null);
    const artifact = { schemaVersion: 1, kind: 'paired-real-session', taskId: 'desktop-task-proof', complete: true };
    await writeArtifactFile(target.outFile, artifact);
    assert.deepEqual(JSON.parse(await fs.readFile(target.outFile, 'utf8')), artifact);
    assert.equal((await fs.stat(target.outFile)).mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(parent)).filter((name) => name.endsWith('.tmp')), []);

    // A channel component that resolves outside the channel root is not that
    // channel: the target is refused before anything is created outside it.
    const escaped = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-write-escape-')));
    try {
      const escapedChannel = path.join(escaped, 'channel');
      await fs.mkdir(escapedChannel);
      await fs.symlink(outside, path.join(escapedChannel, 'storages'));
      const escapedTarget = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: escapedChannel });
      await assert.rejects(inspectArtifactTarget(escapedTarget), /inside the channel home/);
      await assert.rejects(prepareArtifactDirectory(escapedTarget), /inside the channel home/);
      assert.deepEqual(await fs.readdir(outside), [], 'a refused target must not create directories outside the channel');
    } finally {
      await fs.rm(escaped, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a channel swapped after the preflight is re-validated before the artifact is written', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-swap-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-swap-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-swap-outside-')));
  try {
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    await inspectArtifactTarget(target);
    // The target may change while the paired sessions run.
    await fs.symlink(outside, path.join(channel, 'storages'));
    await assert.rejects(prepareArtifactDirectory(target), /inside the channel home/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a channel root replaced after the preflight is refused before anything is created outside it', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-root-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-root-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-root-outside-')));
  try {
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    await inspectArtifactTarget(target);
    // The canonical channel root itself can be swapped while the sessions run.
    await fs.rm(channel, { recursive: true, force: true });
    await fs.symlink(outside, channel);
    await assert.rejects(prepareArtifactDirectory(target), /channel home must be a directory/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a symlinked parent of the channel root is refused before anything is created', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-parent-home-')));
  const parent = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-parent-root-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-parent-outside-')));
  try {
    const channel = path.join(parent, 'channel');
    await fs.mkdir(channel);
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    await inspectArtifactTarget(target);
    // The canonical root is still a directory through the swapped parent, so the
    // walk must compare the resolved path of the root, not just lstat it.
    await fs.rename(parent, `${parent}.old`);
    await fs.symlink(outside, parent);
    // The swapped-away tree keeps a same-named channel: lstat then still sees a
    // directory, so only the canonical-path check can refuse the write.
    await fs.mkdir(path.join(outside, 'channel'));
    await assert.rejects(prepareArtifactDirectory(target), /channel home resolved to a different path|channel home must be a directory/);
    assert.deepEqual(await fs.readdir(path.join(outside, 'channel')), [], 'the swapped tree must stay empty');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(`${parent}.old`, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a shared artifact target is re-verified before the producer uses it', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-shared-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-shared-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-shared-outside-')));
  try {
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    assert.deepEqual(await assertResolvedArtifactTarget(target, { home, taskId: 'desktop-task-proof' }), target);
    await assert.rejects(assertResolvedArtifactTarget(target, { home, taskId: 'other-task' }), /different task id/);
    // An alias is not a canonical channel: the shared target must name the real one.
    const alias = path.join(outside, 'channel-alias');
    await fs.symlink(channel, alias);
    const aliased = { taskId: 'desktop-task-proof', channel: alias, outFile: path.join(alias, 'storages', 'evolution', 'desktop-tasks', 'task-evidence', 'desktop-task-proof.json') };
    await assert.rejects(assertResolvedArtifactTarget(aliased, { home, taskId: 'desktop-task-proof' }), /not a canonical path/);
    // A target that does not match its channel, or escapes the isolated home, is refused.
    await assert.rejects(assertResolvedArtifactTarget({ ...target, outFile: path.join(channel, 'desktop-task-proof.json') }, { home, taskId: 'desktop-task-proof' }), /does not match its channel/);
    const escaped = { taskId: 'desktop-task-proof', channel: null, outFile: path.join(outside, 'desktop-task-proof.json') };
    await assert.rejects(assertResolvedArtifactTarget(escaped, { home, taskId: 'desktop-task-proof' }), /isolated home/);
    // A target resolved against one home must not become a channel inside another.
    const otherHome = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-shared-other-')));
    await fs.mkdir(path.join(otherHome, 'channel'));
    const nested = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: path.join(otherHome, 'channel') });
    await assert.rejects(assertResolvedArtifactTarget(nested, { home: otherHome, taskId: 'desktop-task-proof' }), /must not be the isolated home/);
    await fs.rm(otherHome, { recursive: true, force: true });
    // The legacy isolated `--out` may keep its own file name; only channel
    // delivery requires <taskId>.json.
    const legacy = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', outFile: path.join(home, 'artifact.json') });
    assert.equal(legacy.outFile, path.join(home, 'artifact.json'));
    await assertResolvedArtifactTarget(legacy, { home, taskId: 'desktop-task-proof' });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('the operator report is compared after resolving every alias of the target', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-report-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-report-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-report-outside-')));
  try {
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    const alias = path.join(outside, 'channel-alias');
    await fs.symlink(channel, alias);
    // Any write inside the channel is a second write into the profile that reads
    // the evidence, whatever spelling or symlink the operator used.
    for (const reportPath of [
      target.outFile,
      path.join(channel, 'report.json'),
      path.join(alias, 'storages', 'evolution', 'desktop-tasks', 'task-evidence', 'desktop-task-proof.json'),
    ]) {
      await assert.rejects(assertReportOutsideEvidence(reportPath, target), /must not be written over the task evidence|must stay outside the channel home/);
    }
    // A report symlink that points at the artifact is refused once the target exists.
    await fs.mkdir(path.dirname(target.outFile), { recursive: true });
    await fs.writeFile(target.outFile, '{}');
    const link = path.join(outside, 'report-link.json');
    await fs.symlink(target.outFile, link);
    await assert.rejects(assertReportOutsideEvidence(link, target), /must not be written over the task evidence|must stay outside the channel home/);
    // A dangling report symlink has no resolved path yet; its destination is
    // still inside the channel, so it is refused before writeFile follows it.
    const dangling = path.join(outside, 'report-dangling.json');
    await fs.symlink(path.join(channel, 'storages', 'report.json'), dangling);
    await assert.rejects(assertReportOutsideEvidence(dangling, target), /must stay outside the channel home/);
    assert.equal(existsSync(path.join(channel, 'storages', 'report.json')), false);
    // Relative link targets resolve from the directory that really contains the
    // link, not from the alias the operator spelled.
    const deep = path.join(outside, 'deep', 'real');
    await fs.mkdir(deep, { recursive: true });
    await fs.symlink(path.join(channel, 'storages'), path.join(outside, 'inside'));
    await fs.symlink(deep, path.join(outside, 'alias'));
    await fs.symlink(path.join('..', '..', 'inside', 'report.json'), path.join(deep, 'report.json'));
    await assert.rejects(assertReportOutsideEvidence(path.join(outside, 'alias', 'report.json'), target), /must stay outside the channel home/);
    assert.equal(existsSync(path.join(channel, 'storages', 'report.json')), false);

    // \`hop/..\` must follow \`hop\` before applying \`..\`: lexical folding names a file
    // outside the channel while the filesystem names one inside it.
    const hop = path.join(outside, 'hop');
    await fs.symlink(path.join(channel, 'storages'), hop);
    const hopReport = path.join(outside, 'hop-report.json');
    // Kept as a literal: path.join would collapse \`hop/..\` before the link exists.
    await fs.symlink('hop/../report.json', hopReport);
    await assert.rejects(assertReportOutsideEvidence(hopReport, target), /must stay outside the channel home/);
    assert.equal(existsSync(path.join(channel, 'report.json')), false);
    await assertReportOutsideEvidence(path.join(outside, 'report.json'), target);

    // The isolated mode only refuses the artifact itself.
    const isolated = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof' });
    await assert.rejects(assertReportOutsideEvidence(isolated.outFile, isolated), /must not be written over the task evidence/);
    await assertReportOutsideEvidence(path.join(outside, 'ok.json'), isolated);
    // On a case-insensitive filesystem a case variant is the same file: it must
    // be refused by identity, not by spelling.
    await fs.mkdir(path.dirname(isolated.outFile), { recursive: true });
    await fs.writeFile(isolated.outFile, '{}');
    const upper = isolated.outFile.replace(/desktop-task-proof\.json$/, 'DESKTOP-TASK-PROOF.json');
    const caseInsensitive = await fs.stat(upper).then(() => true).catch(() => false);
    if (caseInsensitive) {
      await assert.rejects(assertReportOutsideEvidence(upper, isolated), /must not be written over the task evidence/);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('the report is written to the exact path the boundary check approved', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-write-report-home-')));
  const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-write-report-root-')));
  const outside = path.join(root, 'outside');
  const other = path.join(root, 'other');
  await fs.mkdir(outside);
  await fs.mkdir(other);
  try {
    const channel = path.join(root, 'channel');
    await fs.mkdir(channel);
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    await fs.mkdir(path.dirname(target.outFile), { recursive: true });
    await fs.writeFile(target.outFile, '{"evidence":true}');
    // \`hop\` points outside the channel: the filesystem resolves the link first and
    // then applies \`..\`, so the write lands next to hop's target, not next to the
    // link. Lexical folding would name a file beside the artifact.
    await fs.symlink(other, path.join(outside, 'hop'));
    const report = path.join(outside, 'report.json');
    await fs.symlink('hop/../report.json', report);
    const destination = await assertReportOutsideEvidence(report, target);
    assert.equal(destination, path.join(root, 'report.json'));
    const written = await writeReportFile(report, target, { ok: true });
    assert.equal(written, destination);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { ok: true });
    assert.equal(JSON.parse(await fs.readFile(target.outFile, 'utf8')).evidence, true);
    // The link still names that destination; no second file was created beside the
    // link by a lexical fold.
    assert.equal(await fs.realpath(report), destination);

    // A case-variant spelling of the channel directory is the same directory on a
    // case-insensitive filesystem, so the report is still inside the channel.
    const upperChannel = path.join(path.dirname(channel), path.basename(channel).toUpperCase());
    const caseInsensitive = await fs.stat(upperChannel).then((info) => info.isDirectory()).catch(() => false);
    if (caseInsensitive) {
      await assert.rejects(assertReportOutsideEvidence(path.join(upperChannel, 'report.json'), target), /must stay outside the channel home/);
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a missing component before .. is refused instead of folded into the channel', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-fold-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-fold-channel-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-fold-outside-')));
  try {
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: channel });
    const existing = path.join(channel, 'storages', 'existing.json');
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(existing, '{"keep":true}');
    await fs.symlink(path.join(channel, 'storages'), path.join(outside, 'alias'));
    // The filesystem fails `missing/../alias/existing.json`; folding it would name
    // the existing file inside the channel.
    await assert.rejects(
      assertReportOutsideEvidence(`${outside}/missing/../alias/existing.json`, target),
      /parent reference below a missing directory/,
    );
    assert.equal(await fs.readFile(existing, 'utf8'), '{"keep":true}');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('a relative report path is resolved from the working directory without folding', async () => {
  const cliModule = pathToFileURL(fileURLToPath(new URL('../scripts/acceptance/task-benefit.mjs', import.meta.url))).href;
  const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-relative-')));
  const here = path.join(root, 'here');
  const other = path.join(root, 'other');
  try {
    await fs.mkdir(here);
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'report.json'), '{}');
    await fs.symlink(other, path.join(here, 'hop'));
    const script = 'import { resolveFilesystemPath } from ' + JSON.stringify(cliModule) + ';' + String.fromCharCode(10) + "process.stdout.write(await resolveFilesystemPath('hop/../report.json'));";
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: here, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, path.join(root, 'report.json'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the report resolver keeps directory semantics for trailing separators and dots', async () => {
  const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-semantics-')));
  try {
    const file = path.join(root, 'report.json');
    await fs.writeFile(file, '{}');
    assert.equal(await resolveFilesystemPath(file), file);
    // The filesystem answers ENOTDIR for these; folding them would name the file.
    await assert.rejects(resolveFilesystemPath(`${file}/`), /must name a directory/);
    await assert.rejects(resolveFilesystemPath(`${file}/.`), /must name a directory/);
    await assert.rejects(resolveFilesystemPath(`${file}/../other.json`), /passes through a non-directory/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
 test('an absolute channel spelling resolves through the filesystem, not lexically', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-channel-home-')));
  const root = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-channel-root-')));
  try {
    const deeper = path.join(root, 'a', 'b');
    await fs.mkdir(deeper, { recursive: true });
    const sibling = path.join(root, 'a', 'two');
    await fs.mkdir(sibling);
    // The lexically folded spelling names this one, but the filesystem does not.
    await fs.mkdir(path.join(root, 'two'));
    await fs.mkdir(path.join(root, 'absent'));
    await fs.symlink(deeper, path.join(root, 'hop'));
    const target = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: `${root}/hop/../two` });
    assert.equal(target.channel, sibling);
    assert.notEqual(target.channel, path.join(root, 'two'));
    // The same spelling whose real destination is missing is refused, even though
    // the folded spelling exists.
    await assert.rejects(resolveArtifactTarget({ home, taskId: 'desktop-task-proof', channelHome: `${root}/hop/../absent` }), /existing directory/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});
 test('the isolated storage roots are pinned to the isolated home before any session', async () => {
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-storage-home-')));
  const outside = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-storage-outside-')));
  try {
    await assertIsolatedStorageRoots(home);
    await fs.mkdir(path.join(home, 'storages'));
    await fs.symlink(outside, path.join(home, 'storages', 'evolution'));
    await assert.rejects(assertIsolatedStorageRoots(home), /isolated storages\/evolution must stay inside the isolated home/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('the command line refuses a valueless --channel-home and a report over the evidence', async () => {
  const cli = fileURLToPath(new URL('../scripts/acceptance/task-benefit.mjs', import.meta.url));
  const home = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-cli-home-')));
  const channel = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-cli-channel-')));
  try {
    const taskFile = path.join(home, 'task.json');
    const hostFile = path.join(home, 'host.js');
    await fs.writeFile(taskFile, JSON.stringify({ id: 'read-long-line', prompt: 'read it', expect: 'sentinel' }));
    await fs.writeFile(hostFile, 'return { name: "cli-fixture", inject: ["tools"], apply() {} };');
    const base = [cli, '--home', home, '--task', taskFile, '--candidate-host', hostFile];
    const dropped = spawnSync(process.execPath, [...base, '--channel-home'], { encoding: 'utf8' });
    assert.notEqual(dropped.status, 0);
    assert.match(dropped.stderr, /--channel-home needs a value/);
    const evidence = path.join(channel, 'storages', 'evolution', 'desktop-tasks', 'task-evidence', 'desktop-task-proof.json');
    const overwrite = spawnSync(process.execPath, [...base, '--channel-home', channel, '--task-id', 'desktop-task-proof', '--report', evidence], { encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /must not be written over the task evidence|must stay outside the channel home/);
    assert.equal(existsSync(evidence), false);
    const beside = spawnSync(process.execPath, [...base, '--channel-home', channel, '--task-id', 'desktop-task-proof', '--report', path.join(path.dirname(evidence), 'report.json')], { encoding: 'utf8' });
    assert.notEqual(beside.status, 0);
    assert.match(beside.stderr, /must stay outside the channel home/);
    assert.equal(existsSync(path.join(path.dirname(evidence), 'report.json')), false);
    const atRoot = spawnSync(process.execPath, [...base, '--channel-home', channel, '--task-id', 'desktop-task-proof', '--report', path.join(channel, 'report.json')], { encoding: 'utf8' });
    assert.notEqual(atRoot.status, 0);
    assert.match(atRoot.stderr, /must stay outside the channel home/);
    assert.equal(existsSync(path.join(channel, 'report.json')), false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
  }
});

test('only allowlisted structured error codes can reach the evidence', () => {
  assert.equal(safeErrorCode({ code: 'E_DESKTOP_TASK_EVIDENCE_MISSING' }), 'E_DESKTOP_TASK_EVIDENCE_MISSING');
  assert.equal(safeErrorCode({ code: 'API_KEY=E_EXAMPLE_PRIVATE_TOKEN' }), null);
  assert.equal(safeErrorCode({ message: 'API_KEY=E_EXAMPLE_PRIVATE_TOKEN' }), null);
  assert.equal(safeErrorCode(new Error('E_DESKTOP_TASK_EVIDENCE_MISSING')), null);
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
