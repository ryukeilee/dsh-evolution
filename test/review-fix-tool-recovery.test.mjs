// A tool failure can be followed by a long run of successes. Before this fix
// those successes lived only in the collector's in-process LRU, so the shared
// store kept `attempts=5, successes=0` and the planner reported a 100% observed
// failure rate for a target that had already recovered. The collector now writes
// one bounded `tool/recovery` success fact after five consecutive clean successes
// in a failure episode, giving the planner a durable resolution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';

import { apply as applyCollector } from '../lib/experience-collector.js';
import { planEvolutionCandidates } from '../lib/experience-plan.js';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function mounted(t) {
  const app = new Context();
  app.provide('tools', { register() {} });
  const fiber = app.plugin(applyCollector, { dshHome: temporary(t) });
  await fiber.await();
  t.after(async () => { await fiber.dispose(); });
  return app;
}

const failed = (code = 'CODE_RUN_FAILED') => ({ isError: true, error: { message: 'failed', info: { code } } });
const succeeded = () => ({ isError: false });
const truncatedRead = () => ({
  isError: false,
  value: { path: '/tmp/truncated.json', offset: 1, lines: [{ number: 1, text: `${'x'.repeat(2000)}... (line truncated to 2000 chars)` }], totalLines: 1 },
});

function emitRun(app, agent, prefix, failures, successes) {
  for (let index = 0; index < failures; index += 1) {
    app.emit('tools/result', { agent, name: 'read', callId: `${prefix}-fail-${index}` }, failed());
  }
  for (let index = 0; index < successes; index += 1) {
    app.emit('tools/result', { agent, name: 'read', callId: `${prefix}-ok-${index}` }, succeeded());
  }
}

const recoveryRows = (records) => records.filter((row) => row.issueType === 'tool recovery');

test('five failures then five successes write a recovery fact and resolve the target', async (t) => {
  const app = await mounted(t);
  const agent = { id: 'recovery-five' };
  emitRun(app, agent, 'five', 5, 5);
  const store = app.get('evolutionExperience').store;
  const records = store.discover().records;
  const [recovery] = recoveryRows(records);
  assert.ok(recovery, 'a recovery fact must be discoverable after five successes');
  assert.equal(recovery.scope, 'tool read');
  assert.equal(recovery.failureCount, 0, 'a recovery is not a failure');
  assert.ok(recovery.successCount >= 1, 'a recovery is a success');
  const plan = planEvolutionCandidates({ knowledge: records, failureMemory: [] });
  assert.equal(plan.selected, null, 'the recovered target must not be selected');
  const rejected = plan.rejected.find((row) => row.problemKey === 'tool read');
  assert.ok(rejected, `tool read should be rejected, got ${JSON.stringify(plan)}`);
  assert.equal(rejected.reason, 'already-resolved');
});

test('four successes stay in the window and keep the target a candidate', async (t) => {
  const app = await mounted(t);
  const agent = { id: 'recovery-four' };
  emitRun(app, agent, 'four', 5, 4);
  const records = app.get('evolutionExperience').store.discover().records;
  assert.equal(recoveryRows(records).length, 0, 'below the threshold no recovery fact is written');
  const plan = planEvolutionCandidates({ knowledge: records, failureMemory: [] });
  const candidate = plan.candidates.find((row) => row.problemKey === 'tool read');
  assert.ok(candidate, `tool read should still be a candidate: ${JSON.stringify(plan)}`);
});

test('four clean successes plus one truncated success do not write a recovery fact', async (t) => {
  const app = await mounted(t);
  const agent = { id: 'recovery-clean-only' };
  emitRun(app, agent, 'clean', 5, 4);
  app.emit('tools/result', { agent, name: 'read', callId: 'clean-truncated' }, truncatedRead());
  const records = app.get('evolutionExperience').store.discover().records;
  assert.equal(recoveryRows(records).length, 0, 'a degraded success does not count toward recovery');
  const plan = planEvolutionCandidates({ knowledge: records, failureMemory: [] });
  assert.ok(plan.candidates.some((row) => row.problemKey === 'tool read'),
    `tool read should still be a candidate: ${JSON.stringify(plan)}`);
});

test('a new failure reopens the target and a second episode writes a second recovery fact', async (t) => {
  const app = await mounted(t);
  const agent = { id: 'recovery-twice' };
  emitRun(app, agent, 'episode-1', 5, 5);
  const store = app.get('evolutionExperience').store;
  const afterFirst = store.stats().events;
  assert.deepEqual(recoveryRows(store.discover().records).map((row) => row.successCount), [1]);

  emitRun(app, agent, 'episode-2', 5, 0);
  const reopened = planEvolutionCandidates({ knowledge: store.discover().records, failureMemory: [] });
  assert.ok(reopened.candidates.some((row) => row.problemKey === 'tool read'),
    `a fresh failure must reopen the target: ${JSON.stringify(reopened.rejected)}`);
  emitRun(app, agent, 'episode-2-ok', 0, 5);

  // Five new failure events and one new recovery event: a duplicate recovery id
  // would not insert a new ledger row.
  assert.equal(store.stats().events, afterFirst + 6);
  const recoveries = recoveryRows(store.discover().records);
  assert.equal(recoveries.length, 1, 'both recovery facts merge into one canonical row');
  assert.equal(recoveries[0].successCount, 2, 'the second event is counted in the same row');
  const settled = planEvolutionCandidates({ knowledge: store.discover().records, failureMemory: [] });
  assert.equal(settled.rejected.find((row) => row.problemKey === 'tool read')?.reason, 'already-resolved');
});

test('successes beyond the threshold do not repeat the recovery event', async (t) => {
  const app = await mounted(t);
  const agent = { id: 'recovery-long' };
  emitRun(app, agent, 'long', 5, 200);
  const store = app.get('evolutionExperience').store;
  const recoveries = recoveryRows(store.discover().records);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].successCount, 1, 'one episode writes exactly one recovery fact');
  assert.equal(store.stats().events, 6, 'five failures plus one recovery event');
});
