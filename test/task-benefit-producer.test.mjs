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
  assertIsolatedStorageRoots,
  assertIsolatedTarget,
  assertReportOutsideEvidence,
  assertResolvedArtifactTarget,
  buildTaskBenefitArtifact,
  extractSessionEvidence,
  inspectArtifactTarget,
  normalizeTask,
  parseExpectTokens,
  prepareArtifactDirectory,
  resolveArtifactTarget,
  safeErrorCode,
  writeArtifactFile,
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
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '<content>sentinel-a sentinel-b sentinel-c</content>' } }] },
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
      await assert.rejects(assertReportOutsideEvidence(reportPath, target), /must stay outside the channel home/);
    }
    // A report symlink that points at the artifact is refused once the target exists.
    await fs.mkdir(path.dirname(target.outFile), { recursive: true });
    await fs.writeFile(target.outFile, '{}');
    const link = path.join(outside, 'report-link.json');
    await fs.symlink(target.outFile, link);
    await assert.rejects(assertReportOutsideEvidence(link, target), /must stay outside the channel home/);
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
    await assertReportOutsideEvidence(path.join(outside, 'report.json'), target);

    // The isolated mode only refuses the artifact itself.
    const isolated = await resolveArtifactTarget({ home, taskId: 'desktop-task-proof' });
    await assert.rejects(assertReportOutsideEvidence(isolated.outFile, isolated), /must not be written over the task evidence/);
    await assertReportOutsideEvidence(path.join(outside, 'ok.json'), isolated);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(channel, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
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
    assert.match(overwrite.stderr, /must stay outside the channel home/);
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
