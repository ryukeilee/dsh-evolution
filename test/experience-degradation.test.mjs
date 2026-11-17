// Non-error degradation observations (2026-11-18).
//
// The discovery side used to see only failures, so a read that silently
// truncated a long line was invisible even though real sessions paid an extra
// tool call to recover. These tests pin the classifier, the neutral fact family
// (it must not enter the failure denominator), the recovery cost projection,
// and the planner's loss-aware ranking.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openSharedExperience, experienceEventId } from '../lib/shared-experience.js';
import { detectDegradation } from '../lib/experience-collector.js';
import { planEvolutionCandidates } from '../lib/experience-plan.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-degradation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const truncatedRead = {
  isError: false,
  value: { path: '/tmp/generated.json', offset: 1, lines: [{ number: 1, text: `${'x'.repeat(2000)}... (line truncated to 2000 chars)` }], totalLines: 1 },
};
const completeRead = {
  isError: false,
  value: { path: '/tmp/generated.json', offset: 1, lines: [{ number: 1, text: 'x'.repeat(3135) }], totalLines: 1 },
};

test('the collector classifies only a successful read that lost data', () => {
  assert.deepEqual(detectDegradation({ name: 'read' }, truncatedRead), { target: 'tool:read', kind: 'line-truncated', path: '/tmp/generated.json' });
  assert.equal(detectDegradation({ name: 'read' }, completeRead), null);
  assert.equal(detectDegradation({ name: 'bash' }, truncatedRead), null);
  assert.equal(detectDegradation({ name: 'read' }, { isError: true, error: { message: 'boom' } }), null);
  const capped = { isError: false, content: [{ type: 'text', text: '<content>1: x\n\n(Output capped. Showing lines 1-1. Use offset=2 to continue.)\n</content>' }] };
  assert.deepEqual(detectDegradation({ name: 'read' }, capped), { target: 'tool:read', kind: 'output-capped', path: null });
  const prose = { isError: false, content: [{ type: 'text', text: '<content>1: prose mentions (Output capped. Showing lines 1-1. Use offset=2 to continue.) but is not a footer\n</content>' }] };
  assert.equal(detectDegradation({ name: 'read' }, prose), null);
  const spoofed = { isError: false, content: [{ type: 'text', text: '<content>1: normal\n(Output capped. Showing lines 1-1. Use offset=2 to continue.) extra\n</content>' }] };
  assert.equal(detectDegradation({ name: 'read' }, spoofed), null);
});

test('a degradation is a neutral fact with a measured recovery call', (t) => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  for (let index = 0; index < 3; index += 1) {
    store.recordDegradation({
      id: experienceEventId('degradation', index),
      target: 'tool:read',
      kind: 'line-truncated',
      recoveryTool: 'bash',
      recoveryCalls: 1,
    });
  }
  const discovered = store.discover();
  const row = discovered.records.find((record) => record.issueType === 'tool degradation');
  assert.ok(row, 'the degradation fact must be discoverable');
  assert.equal(row.failureCount, 0, 'a degradation is not a failure');
  assert.equal(row.successCount, 0, 'a degradation is not a resolution');
  assert.equal(row.occurrences, 3);
  assert.equal(row.failureMode, 'line-truncated');
  assert.equal(row.recoveryTool, 'tool:bash');
  assert.equal(row.metrics.recoverycalls.sum, 3);
  // The error path must still be a separate fact and denominator.
  store.recordFailure({ id: experienceEventId('failure', 1), type: 'tool/error', code: 'FS_NOT_FOUND', target: 'tool:read' });
  const after = store.discover();
  const errorRow = after.records.find((record) => record.failureCount > 0);
  assert.ok(errorRow, 'the error fact must survive next to the degradation');
});

test('the planner ranks a degradation by frequency, recovery cost and recoverability', (t) => {
  const root = temporary(t);
  const store = openSharedExperience(root);
  t.after(() => store.close());
  for (let index = 0; index < 6; index += 1) {
    store.recordDegradation({
      id: experienceEventId('degradation-plan', index),
      target: 'tool:read',
      kind: 'line-truncated',
      recoveryTool: index < 4 ? 'bash' : 'run_code',
      recoveryCalls: 1,
    });
  }
  const planned = planEvolutionCandidates({ knowledge: store.discover().records, failureMemory: [] }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool read');
  assert.ok(candidate, `no tool read candidate: ${JSON.stringify(planned)}`);
  assert.equal(candidate.attribution, 'classified');
  assert.deepEqual(candidate.loss.kinds, ['line-truncated']);
  assert.equal(candidate.loss.occurrences, 6);
  assert.equal(candidate.loss.recoveryCalls, 6);
  assert.equal(candidate.loss.averageRecoveryCalls, 1);
  assert.equal(candidate.loss.recoverable, true);
  // The canonical row keeps the most recent observed recovery path; the
  // per-event recovery count is the metric sum above.
  assert.ok(candidate.loss.recoveryTools.includes('run_code'));
  assert.deepEqual(candidate.benefitModel, { kind: 'workflow', metric: 'failureRate' });
  assert.ok(candidate.acceptanceMetrics.some((metric) => metric.name === 'recoveryCalls' && metric.direction === 'lower'));
  assert.ok(candidate.score > 0);
  // The loss-aware score must prefer the more expensive loss when frequency
  // and recency are equal.
  const withCost = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:costly', scope: 'tool read', issueType: 'tool degradation', failureMode: 'line-truncated',
      occurrences: 3, failureCount: 0, successCount: 0, lastSeen: new Date().toISOString(),
      metrics: { recoverycalls: { sum: 9, count: 3 } }, recoveryTool: 'tool:bash',
    }],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const withNoCost = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:free', scope: 'tool read', issueType: 'tool degradation', failureMode: 'line-truncated',
      occurrences: 3, failureCount: 0, successCount: 0, lastSeen: new Date().toISOString(),
      metrics: { recoverycalls: { sum: 0, count: 3 } }, recoveryTool: '',
    }],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.ok(withCost.candidates[0].score > withNoCost.candidates[0].score);
});

test('a rare degradation stays rejected below the evidence floor', () => {
  const planned = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:rare', scope: 'tool read', issueType: 'tool degradation', failureMode: 'line-truncated',
      occurrences: 2, failureCount: 0, successCount: 0, lastSeen: new Date().toISOString(),
      metrics: { recoverycalls: { sum: 2, count: 2 } },
    }],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.equal(planned.candidates.length, 0);
  assert.equal(planned.rejected[0].reason, 'insufficient-evidence');
});

test('an unrelated caller-input error does not discard a qualifying degradation', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:loss', scope: 'tool read', issueType: 'tool degradation', failureMode: 'line-truncated',
        occurrences: 8, failureCount: 0, successCount: 0, lastSeen: now,
        metrics: { recoverycalls: { sum: 3, count: 8 } }, recoveryTool: 'tool:bash',
      },
      {
        key: 'knowledge:error', scope: 'tool read', problem: 'official operation failure fs not found',
        failureCount: 1, occurrences: 1, lastSeen: now,
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  const candidate = planned.candidates.find((entry) => entry.problemKey === 'tool read');
  assert.ok(candidate, `the degradation was discarded: ${JSON.stringify(planned.rejected)}`);
  assert.ok(candidate.loss);
  assert.notEqual(candidate.origin, 'caller-input');
  // The same caller-input signal without any degradation still stays rejected.
  const pureError = planEvolutionCandidates({
    knowledge: [{
      key: 'knowledge:patch', scope: 'tool apply patch', problem: 'official operation failure fs patch mismatch',
      failureCount: 5, occurrences: 5, lastSeen: now,
    }],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.equal(pureError.candidates.length, 0);
});

test('a single degradation cannot borrow unrelated errors to cross the threshold', () => {
  const now = new Date().toISOString();
  const planned = planEvolutionCandidates({
    knowledge: [
      {
        key: 'knowledge:one-loss', scope: 'tool read', issueType: 'tool degradation', failureMode: 'line-truncated',
        occurrences: 1, failureCount: 0, successCount: 0, lastSeen: now,
        metrics: { recoverycalls: { sum: 1, count: 1 } }, recoveryTool: 'tool:bash',
      },
      {
        key: 'knowledge:errors', scope: 'tool read', problem: 'official operation failure fs not found',
        failureCount: 8, occurrences: 8, lastSeen: now,
      },
    ],
    failureMemory: [],
  }, { minOccurrences: 3 });
  assert.equal(planned.candidates.length, 0);
  const rejected = planned.rejected.find((entry) => entry.problemKey === 'tool read');
  assert.ok(rejected);
  assert.equal(rejected.reason, 'caller-input');
});

test('a below-threshold degradation does not change an ordinary failure candidate', () => {
  const now = new Date().toISOString();
  const errors = [{
    key: 'knowledge:read-errors', scope: 'tool read', problem: 'official operation failure host operation failure',
    failureCount: 8, occurrences: 8, lastSeen: now,
  }];
  const truncation = {
    key: 'knowledge:one-truncation', scope: 'tool read', issueType: 'tool degradation', failureMode: 'line-truncated',
    occurrences: 1, failureCount: 0, successCount: 0, lastSeen: now,
    metrics: { recoverycalls: { sum: 0, count: 1 } },
  };
  const withLoss = planEvolutionCandidates({ knowledge: [...errors, truncation], failureMemory: [] }, { minOccurrences: 3 });
  const without = planEvolutionCandidates({ knowledge: errors, failureMemory: [] }, { minOccurrences: 3 });
  const candidate = withLoss.candidates.find((entry) => entry.problemKey === 'tool read');
  assert.ok(candidate);
  assert.equal(candidate.loss, null);
  assert.equal(candidate.attribution, 'unattributed');
  assert.equal(candidate.benefitModel, undefined);
  assert.equal(candidate.score, without.candidates.find((entry) => entry.problemKey === 'tool read').score);
});

test('the mounted collector defers a degradation to the next call and flushes it at turn end', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { apply: applyCollector } = await import('../lib/experience-collector.js');
  const root = temporary(t);
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: root });
  await fiber.await();
  try {
    const agent = { id: 'degradation-agent' };
    app.emit('tools/result', { callId: 'read-1', name: 'read', agent }, truncatedRead);
    app.emit('tools/result', { callId: 'bash-1', name: 'bash', agent }, { isError: false, value: { exitCode: 0 } });
    app.emit('tools/result', { callId: 'read-2', name: 'read', agent }, truncatedRead);
    app.emit('agent/turn-stopping', { agent });
    const store = app.get('evolutionExperience').store;
    // Both events share the same degradation identity, so the canonical row
    // counts both occurrences; the metric carries the one observed recovery
    // call while the projected recovery path stays the latest observed one.
    const rows = store.discover().records.filter((record) => record.issueType === 'tool degradation');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrences, 2);
    assert.equal(rows[0].recoveryTool, 'tool:bash');
    assert.equal(rows[0].metrics.recoverycalls.sum, 1);
  } finally {
    await fiber.dispose();
  }
});

test('recovery cost counts one successful associated call, not a failure or another file', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { apply: applyCollector } = await import('../lib/experience-collector.js');
  const root = temporary(t);
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: root });
  await fiber.await();
  try {
    const agent = { id: 'recovery-agent' };
    app.emit('tools/result', { callId: 'read-a', name: 'read', agent }, {
      isError: false,
      value: { path: '/tmp/a.json', offset: 1, lines: [{ number: 1, text: 'x'.repeat(2000) + '... (line truncated to 2000 chars)' }], totalLines: 1 },
    });
    app.emit('tools/result', { callId: 'bash-failed', name: 'bash', agent }, { isError: true, error: { message: 'failed' } });
    app.emit('tools/result', { callId: 'read-b', name: 'read', agent }, {
      isError: false,
      value: { path: '/tmp/b.json', offset: 1, lines: [{ number: 1, text: 'x'.repeat(2000) + '... (line truncated to 2000 chars)' }], totalLines: 1 },
    });
    app.emit('tools/result', { callId: 'read-c', name: 'read', agent }, {
      isError: false,
      value: { path: '/tmp/c.json', offset: 1, lines: [{ number: 1, text: 'short' }], totalLines: 1 },
    });
    app.emit('tools/result', { callId: 'bash-nonzero', name: 'bash', agent }, { isError: false, value: { exitCode: 1 } });
    app.emit('tools/result', { callId: 'bash-ok', name: 'bash', agent }, { isError: false, value: { exitCode: 0 } });
    app.emit('agent/turn-stopping', { agent });
    const rows = app.get('evolutionExperience').store.discover().records.filter((record) => record.issueType === 'tool degradation');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrences, 2);
    assert.equal(rows[0].metrics.recoverycalls.sum, 1, 'the failed call and the other-file read are not recoveries');
    assert.equal(rows[0].recoveryTool, 'tool:bash');
  } finally {
    await fiber.dispose();
  }
});

test('a bash that exits non-zero does not settle a pending degradation', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { apply: applyCollector } = await import('../lib/experience-collector.js');
  const root = temporary(t);
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: root });
  await fiber.await();
  try {
    const agent = { id: 'nonzero-agent' };
    app.emit('tools/result', { callId: 'read-1', name: 'read', agent }, {
      isError: false,
      value: { path: '/tmp/a.json', offset: 1, lines: [{ number: 1, text: 'x'.repeat(2000) + '... (line truncated to 2000 chars)' }], totalLines: 1 },
    });
    app.emit('tools/result', { callId: 'bash-1', name: 'bash', agent }, { isError: false, value: { exitCode: 1 } });
    app.emit('agent/turn-stopping', { agent });
    const [row] = app.get('evolutionExperience').store.discover().records.filter((record) => record.issueType === 'tool degradation');
    assert.equal(row.metrics.recoverycalls.sum, 0, 'a non-zero foreground exit is not a recovery');
    assert.equal(row.recoveryTool, '');
  } finally {
    await fiber.dispose();
  }
});

test('a successful re-read of the same path is an associated recovery', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { apply: applyCollector } = await import('../lib/experience-collector.js');
  const root = temporary(t);
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: root });
  await fiber.await();
  try {
    const agent = { id: 'reread-agent' };
    app.emit('tools/result', { callId: 'read-1', name: 'read', agent }, {
      isError: false,
      value: { path: '/tmp/a.json', offset: 1, lines: [{ number: 1, text: 'x'.repeat(2000) + '... (line truncated to 2000 chars)' }], totalLines: 1 },
    });
    app.emit('tools/result', { callId: 'read-2', name: 'read', agent }, {
      isError: false,
      value: { path: '/tmp/a.json', offset: 1, lines: [{ number: 1, text: 'complete line' }], totalLines: 1 },
    });
    app.emit('agent/turn-stopping', { agent });
    const [row] = app.get('evolutionExperience').store.discover().records.filter((record) => record.issueType === 'tool degradation');
    assert.equal(row.occurrences, 1);
    assert.equal(row.metrics.recoverycalls.sum, 1);
    assert.equal(row.recoveryTool, 'tool:read');
  } finally {
    await fiber.dispose();
  }
});

test('a re-read settles only its own path and keeps the other loss pending', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { apply: applyCollector } = await import('../lib/experience-collector.js');
  const root = temporary(t);
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: root });
  await fiber.await();
  try {
    const agent = { id: 'paths-agent' };
    const truncated = (path) => ({ isError: false, value: { path, offset: 1, lines: [{ number: 1, text: 'x'.repeat(2000) + '... (line truncated to 2000 chars)' }], totalLines: 1 } });
    app.emit('tools/result', { callId: 'read-a', name: 'read', agent }, truncated('/tmp/a.json'));
    app.emit('tools/result', { callId: 'read-b', name: 'read', agent }, truncated('/tmp/b.json'));
    app.emit('tools/result', { callId: 'read-b2', name: 'read', agent }, { isError: false, value: { path: '/tmp/b.json', offset: 1, lines: [{ number: 1, text: 'complete b' }], totalLines: 1 } });
    app.emit('agent/turn-stopping', { agent });
    const [row] = app.get('evolutionExperience').store.discover().records.filter((record) => record.issueType === 'tool degradation');
    assert.equal(row.occurrences, 2);
    assert.equal(row.metrics.recoverycalls.sum, 1, 'only the matching path is settled; A stays unrecovered');
    assert.equal(row.recoveryTool, 'tool:read');
  } finally {
    await fiber.dispose();
  }
});
