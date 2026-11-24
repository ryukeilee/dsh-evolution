// Feedback / reuse evidence fidelity regressions (open research round 6).
//
// Four cross-stage gaps were found in the full self-evolution chain:
//   1. capability-usage dedups tool calls by callId, but the official host
//      reuses callId across execution objects (PTC envelopes), so real calls
//      and lifecycle attribution are silently lost.
//   2. a task-coupled experiment records its real before/after numbers only on
//      latestObservation, so the durable conclusion carries empty metrics.
//   3. a revoked/disabled record is still reported as currently in use because
//      the value tier never checks whether the record is active anywhere.
//   4. a truncated discovery window is reported to the planner as
//      "no-failure-signal" instead of "the window withheld older facts".
//
// Every test is synthetic and uses only os.tmpdir() paths or pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSessionCounter } from '../lib/capability-usage.js';
import { knowledgeExperienceRecord } from '../lib/experience-recall.js';
import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { readPublishedPluginReview, reviewExperience } from '../lib/self-evolution-review.js';
import { openSharedExperience } from '../lib/shared-experience.js';
import {
  buildSharedRecord,
  consumerStateDocument,
  publishSharedRecord,
  readSharedIndex,
  setDisabledForProfile,
  writeConsumerState,
} from '../lib/promoted-sharing.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// 1. callId reuse must not swallow calls or misclassify verification as usage
// ---------------------------------------------------------------------------

test('a call sharing a lifecycle callId is counted but never guessed as usage', () => {
  const counter = createSessionCounter(new Set(['published_tool']));
  const reopened = counter.call({ type: 'tool/call', data: { callId: 'reused-id', name: 'evolution_trial' } });
  assert.equal(reopened, 'lifecycle');
  const published = counter.call({ type: 'tool/call', data: { callId: 'reused-id', name: 'published_tool' } });
  assert.equal(published, 'pending', 'a real call with a reused callId must not be dropped as a duplicate');
  // The published call's result arrives first. It must not close the Trial:
  // a reused callId cannot prove which execution returned.
  counter.call({ type: 'tool/result', data: { toolCallId: 'reused-id' } });
  const later = counter.call({ type: 'tool/call', data: { callId: 'later-id', name: 'published_tool' } });
  assert.equal(later, 'pending', 'the Trial must still be open, so the later call is not workflow');
  counter.call({ type: 'tool/result', data: { toolCallId: 'reused-id' } });
  const counts = counter.finish();
  assert.equal(counts.get('published_tool').workflow, 0);
  assert.equal(counts.get('published_tool').verification, 0);
  assert.equal(counts.get('published_tool').unattributed, 2, 'ambiguous attribution stays unattributed, never a guessed verdict');
});

test('official event seq links close reused callId lifecycles exactly', () => {
  const counter = createSessionCounter(new Set(['published_tool']));
  const call = (seq) => ({ type: 'tool/call', seq, data: { callId: 'reused', name: 'evolution_trial' } });
  const result = (seq) => ({ type: 'tool/result', seq: seq + 1000, sourceEventSeqs: [seq], data: { toolCallId: 'reused' } });
  assert.equal(counter.call(call(1)), 'lifecycle');
  counter.call(result(1));
  assert.equal(counter.call(call(2)), 'lifecycle');
  counter.call(result(2));
  // Both lifecycles are closed by their exact seq link; the reused callId no
  // longer keeps the session occupied.
  assert.equal(counter.call({ type: 'tool/call', seq: 3, data: { callId: 'fresh', name: 'published_tool' } }), 'workflow');
  assert.equal(counter.finish().get('published_tool').workflow, 1);
});

test('an unpublished tool reusing a lifecycle callId cannot close the Trial', () => {
  const counter = createSessionCounter(new Set(['published_tool']));
  counter.call({ type: 'tool/call', data: { callId: 'shared', name: 'evolution_trial' } });
  assert.equal(counter.call({ type: 'tool/call', data: { callId: 'shared', name: 'read' } }), 'ignored');
  // The ordinary tool's result must not close the still-running Trial.
  counter.call({ type: 'tool/result', data: { toolCallId: 'shared' } });
  assert.equal(counter.call({ type: 'tool/call', data: { callId: 'fresh', name: 'published_tool' } }), 'pending');
  counter.call({ type: 'tool/result', data: { toolCallId: 'fresh' } });
  counter.call({ type: 'tool/result', data: { toolCallId: 'shared' } });
  const counts = counter.finish();
  assert.equal(counts.get('published_tool').workflow, 0);
  assert.equal(counts.get('published_tool').unattributed, 1);
});

test('two real calls with a reused callId are both counted', () => {
  const counter = createSessionCounter(new Set(['published_tool']));
  assert.equal(counter.call({ type: 'tool/call', data: { callId: 'shared-id', name: 'published_tool' } }), 'workflow');
  assert.equal(counter.call({ type: 'tool/call', data: { callId: 'shared-id', name: 'published_tool' } }), 'workflow');
  const counts = counter.finish();
  assert.equal(counts.get('published_tool').workflow, 2);
});

// ---------------------------------------------------------------------------
// 2. taskBenefit numbers and regression must reach the durable conclusion
// ---------------------------------------------------------------------------

function conclusionStub() {
  const captured = [];
  return {
    captured,
    orchestrator: {
      sharedExperience: {
        recordConclusion(payload) { captured.push(payload); return true; },
        findConclusions() { return { matches: [] }; },
      },
      paths: { eventBridgePath: path.join(os.tmpdir(), 'evo-no-such-event-bridge') },
      applicability: () => ({ dsh: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.19' }),
      warn() {},
    },
  };
}

test('a task-coupled conclusion carries the measured before/after deltas', () => {
  const { captured, orchestrator } = conclusionStub();
  const record = {
    id: 'exp-task-benefit',
    proposal: { target: 'tool:read', strategy: 'context-policy: read-tail' },
    latestObservation: {
      beforeMetrics: { turns: 12, toolCalls: 8, correct: 2, sessions: 3 },
      afterMetrics: { turns: 9, toolCalls: 5, correct: 3, sessions: 3 },
      taskBenefit: { benefit: true, regression: false, mechanismRan: true, task: { id: 'task-read' } },
    },
  };
  EvolutionOrchestrator.prototype.publishConclusion.call(orchestrator, record, 'adopted');
  assert.equal(captured.length, 1);
  assert.ok(Object.keys(captured[0].metrics).length > 0, 'the conclusion must carry the task benefit numbers');
  assert.equal(captured[0].metrics.turnsDelta, -3);
  assert.equal(captured[0].metrics.toolCallsDelta, -3);
});

test('a task regression keeps the conclusion identity of the same hypothesis', () => {
  const { captured, orchestrator } = conclusionStub();
  const record = {
    id: 'exp-task-regression',
    proposal: { target: 'tool:read', strategy: 'context-policy: read-tail' },
    latestObservation: {
      beforeMetrics: { turns: 9, toolCalls: 5, correct: 3, sessions: 3 },
      afterMetrics: { turns: 12, toolCalls: 8, correct: 2, sessions: 3 },
      taskBenefit: { benefit: false, regression: true, mechanismRan: true, task: { id: 'task-read' } },
    },
  };
  EvolutionOrchestrator.prototype.publishConclusion.call(orchestrator, record, 'regression');
  assert.equal(captured.length, 1);
  // failureMode is a knowledge identity dimension: a task-specific value would
  // leave the regression row alive beside a later adopted verdict. The verdict
  // itself still records the regression.
  assert.equal(captured[0].failureMode, '');
  assert.equal(captured[0].decision, 'regression');
});

test('caller-supplied metrics without a validated task artifact stay out of the shared lesson', () => {
  const { captured, orchestrator } = conclusionStub();
  EvolutionOrchestrator.prototype.publishConclusion.call(orchestrator, {
    id: 'exp-caller-metrics',
    proposal: { target: 'tool:read', strategy: 'caller-supplied' },
    latestObservation: { beforeMetrics: { turns: 10 }, afterMetrics: { turns: 2 } },
  }, 'adopted');
  assert.deepEqual(captured[0].metrics, {});
});

test('an unreadable shared store is not reported as no failure signal', () => {
  const result = reviewExperience({
    store: { discover() { throw new Error('store read failed'); } },
    versions: {},
  });
  assert.equal(result.none?.reason, 'store-unavailable', 'a failed read is not evidence of an empty history');
});

test('task deltas survive a real shared-experience write and discover round trip', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-round6-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = openSharedExperience(root);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  store.recordConclusion({
    experimentId: 'exp-round6-task',
    target: 'tool:read',
    strategy: 'context-policy read-tail',
    strategyFingerprint: 'abcdef0123456789',
    rootCause: 'tail loss',
    failureMode: '',
    decision: 'adopted',
    metrics: { turnsDelta: -3, toolCallsDelta: -3, tokensDelta: -20, durationMsDelta: -500, failuresDelta: 0 },
    applicability: { dsh: '0.2.2-rc.5', cordis: '4.1.0', evolution: '0.2.19' },
    occurredAt: new Date().toISOString(),
  }, 'round6-test');
  const rows = store.discover({ window: 500 }).records;
  const withTurns = rows.find((row) => row.metrics && Object.keys(row.metrics).some((key) => /turns/i.test(key)));
  assert.ok(withTurns, 'the written turns delta must be discoverable by the next planning round');
  assert.ok(Object.keys(withTurns.metrics).some((key) => /duration/i.test(key)), 'the extra metric window must survive');
});

test('all task metric deltas survive the bounded recall projection', () => {
  // A synthetic full window guards the read bound; the real task writer emits
  // the five deltas that can actually differ (sessions/correct are pinned equal
  // by validateTaskBenefit).
  const metrics = Object.fromEntries([
    'sessionsDelta', 'correctDelta', 'failuresDelta', 'turnsDelta',
    'toolCallsDelta', 'tokensDelta', 'durationMsDelta',
  ].map((key) => [key, { sum: -1, count: 1, last: -1 }]));
  const record = knowledgeExperienceRecord({
    knowledgeKey: 'knowledge:task-deltas',
    semanticFact: 'tool read context-policy task benefit',
    scope: 'tool read',
    effectStats: { metrics },
  });
  for (const key of Object.keys(metrics)) {
    assert.ok(Object.hasOwn(record.metrics, key), `${key} must be visible to the next planning round`);
  }
});

test('a regression observed without the candidate running is not attributed to it', () => {
  const { captured, orchestrator } = conclusionStub();
  EvolutionOrchestrator.prototype.publishConclusion.call(orchestrator, {
    id: 'exp-not-run',
    proposal: { target: 'tool:read', strategy: 'context-policy: read-tail' },
    latestObservation: { taskBenefit: { regression: true, mechanismRan: false, task: { id: 'task-read' } } },
  }, 'insufficient-evidence');
  assert.equal(captured[0].failureMode, '');
});

// ---------------------------------------------------------------------------
// 3. a revoked record is not currently in use
// ---------------------------------------------------------------------------

const HOST = Object.freeze({ dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '2.0.3', node: process.version });
const PROFILES = Object.freeze(['acp', 'web']);

async function publishedEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-fidelity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { dataRoot: root, presetDir: root, pluginRoot: path.join(root, 'promoted') };
  const pluginName = 'dsh-evolution-promoted-f1de11f1de11';
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = `export const name = ${JSON.stringify(pluginName)};\nexport const inject = [];\nexport function apply() {}\n`;
  await fs.writeFile(modulePath, source);
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '1.0.0', type: 'module', main: 'lib/index.js' })}\n`);
  const durable = { pluginName, pluginPath: pluginDir, moduleUrl: pathToFileURL(modulePath).href, rowId: 'evolution-promoted-f1de11f1de11' };
  const experiment = {
    id: 'exp-fidelity',
    ownerId: 'desktop-owner',
    state: 'stable',
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: [...PROFILES],
    canary: {
      promotionTimestamp: '2026-01-01T23:00:00.000Z',
      healthObservationWindow: 2,
      startupVerified: true,
      observations: [{ barrierId: 'startup:desktop' }, { barrierId: 'post:desktop' }],
    },
    decision: { kind: 'benefit' },
    durable,
  };
  const record = await buildSharedRecord({
    paths,
    experiment,
    durable,
    journal: null,
    approvedProfiles: [...PROFILES],
    host: HOST,
    capabilities: { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true },
    source: { stableCommittedAt: experiment.stableCommittedAt },
  });
  const outcome = await publishSharedRecord(paths, record);
  assert.equal(outcome.status, 'published');
  const index = await readSharedIndex(paths);
  for (const profile of PROFILES) {
    await writeConsumerState(paths, profile, consumerStateDocument({
      profile,
      host: HOST,
      indexUpdatedAt: index.updatedAt,
      compositionPath: null,
      plugins: [{ id: record.id, status: 'active', reason: null, hostDigest: sha256(JSON.stringify(HOST)), activatedAt: '2026-01-02T00:00:00.000Z' }],
    }));
  }
  return { paths, record };
}

test('a revoked plugin with historical calls is not reported as in-use', async (t) => {
  const { paths, record } = await publishedEnv(t);
  for (const profile of PROFILES) {
    await setDisabledForProfile(paths, { pluginId: record.id, profile, disabled: true, reason: 'operator test' });
  }
  const result = await readPublishedPluginReview({ paths, host: HOST, usage: {
    source: 'session-evidence',
    records: { [record.id]: { workflowInvocations: 5, verificationInvocations: 0, unattributedInvocations: 0, capabilityAssessment: 'self-contained' } },
  } });
  assert.notEqual(result.records[0].value.tier, 'in-use', 'historical calls do not prove current reuse');
  assert.equal(result.valueSummary.inUse, 0);
});

test('a partial revocation does not downgrade a still-approved record', async (t) => {
  const { paths, record } = await publishedEnv(t);
  await setDisabledForProfile(paths, { pluginId: record.id, profile: 'acp', disabled: true, reason: 'operator test' });
  const result = await readPublishedPluginReview({ paths, host: HOST, usage: {
    source: 'session-evidence',
    records: { [record.id]: { workflowInvocations: 5, verificationInvocations: 0, unattributedInvocations: 0, capabilityAssessment: 'self-contained' } },
  } });
  assert.equal(result.records[0].value.tier, 'in-use', 'only ACP was revoked; the web profile is still in the chain');
  assert.equal(result.valueSummary.inUse, 1);
});
