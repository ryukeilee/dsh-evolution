// DSH-EVOLUTION-CHAIN-GAP-03: a missing / stale / legacy-coverage / incomplete /
// damaged usage projection must be executable in the read-only self-evolution
// review and in doctor, without relaxing any retirement gate.
//
// Every fixture is an isolated DSH home under os.tmpdir(). Nothing here reads or
// writes the operator's real data root, starts a session scan, a timer or a
// background model turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildSharedRecord,
  consumerStateDocument,
  hostDigest,
  publishSharedRecord,
  readSharedIndex,
  sharingPaths,
  writeConsumerState,
} from '../lib/promoted-sharing.js';
import {
  boundedReviewActions,
  composeSelfEvolutionReview,
  readPublishedPluginReview,
  REVIEW_ACTIONS,
  SELF_EVOLUTION_REVIEW_LIMITS,
  USAGE_PROJECTION_ACTION_PREFIX,
} from '../lib/self-evolution-review.js';
import {
  USAGE_PROJECTION_COVERAGE,
  readUsageProjection,
  writeUsageProjection,
} from '../lib/capability-usage.js';
import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';

const RECORD_ID = 'evolution-promoted-cccccccccccc';
const PLUGIN_NAME = `dsh-${RECORD_ID}`;
const PROFILES = ['acp', 'web'];
const HOST = Object.freeze({
  profile: 'desktop',
  dsh: '0.2.2-rc.5',
  cordis: '4.1.0',
  include: '2.0.3',
  node: process.version,
  capturedAt: '2026-01-01T00:00:00.000Z',
});
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** One published stable record in a fresh home, with both consumers active. */
async function fixture(t, name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `chain-gap-03-${name}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: home });
  const pluginDir = path.join(paths.pluginRoot, PLUGIN_NAME);
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = `export const name = ${JSON.stringify(PLUGIN_NAME)};\nexport const inject = [];\nexport function apply() {}\n`;
  fs.writeFileSync(modulePath, source);
  const manifest = `${JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', type: 'module', main: 'lib/index.js' })}\n`;
  fs.writeFileSync(path.join(pluginDir, 'package.json'), manifest);
  const experiment = {
    id: `exp-${name}`,
    ownerId: 'desktop-owner',
    state: 'stable',
    stableCommittedAt: '2026-01-01T00:00:00.000Z',
    shareTargets: [...PROFILES],
    canary: {
      promotionTimestamp: '2026-01-01T00:00:00.000Z',
      healthObservationWindow: 2,
      startupVerified: true,
      observations: [{ barrierId: 'startup:desktop' }, { barrierId: 'post:desktop' }],
    },
    decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
    durable: { pluginName: PLUGIN_NAME, pluginPath: pluginDir, moduleUrl: pathToFileURL(modulePath).href, rowId: RECORD_ID },
  };
  const record = await buildSharedRecord({
    paths,
    experiment,
    durable: experiment.durable,
    journal: null,
    approvedProfiles: [...PROFILES],
    host: HOST,
    capabilities: { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true },
    source: { stableCommittedAt: experiment.stableCommittedAt },
  });
  assert.equal((await publishSharedRecord(paths, record)).status, 'published');
  const index = await readSharedIndex(paths);
  assert.equal(index.records.length, 1);
  for (const profile of PROFILES) {
    await writeConsumerState(paths, profile, consumerStateDocument({
      profile,
      host: HOST,
      indexUpdatedAt: index.updatedAt,
      compositionPath: null,
      plugins: [{ id: RECORD_ID, status: 'active', reason: null, hostDigest: hostDigest(HOST), activatedAt: '2026-01-02T00:00:00.000Z' }],
    }));
  }
  return { home, paths, record, index };
}

/** Write one projection through the same writer the operator CLI uses. */
async function writeProjection(env, overrides = {}) {
  const now = new Date('2026-11-27T00:00:00.000Z').getTime();
  const doc = {
    kind: 'dsh-evolution-capability-usage',
    schemaVersion: 1,
    coverage: USAGE_PROJECTION_COVERAGE,
    source: 'session-evidence',
    complete: true,
    recordsComplete: true,
    capturedAt: new Date(now).toISOString(),
    scannedSessions: 2,
    records: {
      [RECORD_ID]: {
        workflowInvocations: 3,
        verificationInvocations: 0,
        unattributedInvocations: 0,
        capabilityAssessment: 'workflow-relevant',
      },
    },
    ...overrides,
  };
  await writeUsageProjection({ dataRoot: env.paths.dataRoot, projection: doc });
  return doc;
}

async function reviewed(env) {
  const loaded = await readUsageProjection({ dataRoot: env.paths.dataRoot });
  const stable = await readPublishedPluginReview({
    paths: env.paths,
    host: HOST,
    usage: loaded.usage,
    usageStatus: loaded.evidence.status,
  });
  return { loaded, stable, composed: composeSelfEvolutionReview({ stable }) };
}

const usageActions = (review) => review.nextActions.filter((row) =>
  typeof row.code === 'string' && row.code.startsWith(USAGE_PROJECTION_ACTION_PREFIX));

async function doctorUsage(env) {
  const report = await collectDiagnostics({ home: env.home, paths: env.paths });
  const check = report.checks.find((row) => row.id === 'promotion.usage');
  assert.ok(check, 'doctor must always emit a promotion.usage check');
  return check;
}

test('absent projection: one bounded operator action with a copyable command, no retirement, doctor degraded', async (t) => {
  const env = await fixture(t, 'absent');
  const { loaded, stable, composed } = await reviewed(env);
  assert.equal(loaded.evidence.status, 'absent');

  const actions = usageActions(stable);
  assert.equal(actions.length, 1, JSON.stringify(stable.nextActions));
  const [action] = actions;
  assert.equal(action.action, REVIEW_ACTIONS.OPERATOR);
  assert.equal(action.code, `${USAGE_PROJECTION_ACTION_PREFIX}absent`);
  assert.deepEqual(action.issues, ['absent']);
  assert.match(action.command, /capability-usage\.mjs/);
  assert.match(action.command, /--write/);
  assert.match(action.command, /--assessments/);
  assert.equal(action.assessments.required, true);
  assert.match(action.assessments.format, /self-contained/);
  assert.ok(action.why.includes('absent'));

  assert.equal(stable.retirementCandidates.length, 0);
  assert.equal(stable.valueSummary.retirementCandidates, 0);
  assert.equal(usageActions(composed).length, 1);

  const check = await doctorUsage(env);
  assert.equal(check.level, 'degraded');
  assert.deepEqual(check.evidence.issues, ['absent']);
  assert.equal(check.evidence.status, 'absent');
  assert.equal(check.evidence.publishedRecordCount, 1);
  assert.match(check.remediation, /--assessments/);
});

test('a fresh, complete projection is healthy in both surfaces (no false warning)', async (t) => {
  const env = await fixture(t, 'healthy');
  await writeProjection(env);
  const { loaded, stable, composed } = await reviewed(env);
  assert.equal(loaded.evidence.status, 'ok');
  assert.equal(loaded.evidence.stale, false);
  assert.equal(usageActions(stable).length, 0);
  assert.equal(usageActions(composed).length, 0);
  assert.equal(stable.records[0].value.tier, 'in-use');
  assert.equal(stable.retirementCandidates.length, 0);

  const check = await doctorUsage(env);
  assert.equal(check.level, 'ok');
  assert.deepEqual(check.evidence.issues, []);
});

test('each missing shape gets its own bounded hint; none swallows another', async (t) => {
  const shapes = [
    { name: 'stale', setup: (env) => writeProjection(env, { capturedAt: '2026-01-01T00:00:00.000Z' }), issue: 'stale', absentText: 'no usage projection has been written' },
    { name: 'legacy', setup: (env) => writeProjection(env, { coverage: 'legacy' }), issue: 'legacy-coverage', absentText: 'older than the 30-day bound' },
    { name: 'incomplete', setup: (env) => writeProjection(env, { complete: false }), issue: 'incomplete', absentText: 'predates the native+PTC' },
    { name: 'invalid', setup: (env) => fs.writeFileSync(sharingPaths(env.paths).usagePath, '{ not json'), issue: 'invalid', absentText: 'older than the 30-day bound' },
  ];
  for (const shape of shapes) {
    await t.test(shape.name, async (child) => {
      const env = await fixture(child, shape.name);
      await shape.setup(env);
      const { loaded, stable } = await reviewed(env);
      const actions = usageActions(stable);
      assert.equal(actions.length, 1, `${shape.name}: ${JSON.stringify(stable.nextActions)}`);
      assert.deepEqual(actions[0].issues, [shape.issue], shape.name);
      assert.equal(actions[0].code, `${USAGE_PROJECTION_ACTION_PREFIX}${shape.issue}`);
      assert.ok(!actions[0].why.includes(shape.absentText), `${shape.name} must not report another shape`);
      assert.match(actions[0].command, /--assessments/);
      assert.equal(stable.retirementCandidates.length, 0);

      const check = await doctorUsage(env);
      assert.equal(check.level, 'degraded', shape.name);
      assert.deepEqual(check.evidence.issues, [shape.issue], shape.name);
      assert.match(check.remediation, /--assessments/);
      assert.ok(loaded.evidence.status === 'ok' || shape.issue === 'invalid');
    });
  }
});

test('the supplement never evicts blocking actions or the bounded-read notice', () => {
  const blockers = Array.from({ length: SELF_EVOLUTION_REVIEW_LIMITS.maxActions - 1 }, (_, index) => ({
    action: REVIEW_ACTIONS.VERIFY_HOST,
    recordId: `record-${index}`,
    why: 'blocking',
  }));
  const capNotice = {
    action: REVIEW_ACTIONS.OPERATOR,
    code: 'review-record-cap',
    recordId: null,
    why: 'the bounded read is incomplete',
  };
  const supplement = {
    action: REVIEW_ACTIONS.OPERATOR,
    code: `${USAGE_PROJECTION_ACTION_PREFIX}absent`,
    recordId: null,
    why: 'no usage projection',
  };
  const { nextActions, nextActionsDropped } = boundedReviewActions([...blockers, capNotice, supplement]);
  assert.equal(nextActions.filter((row) => row.action === REVIEW_ACTIONS.VERIFY_HOST).length, blockers.length);
  assert.ok(nextActions.some((row) => row.code === 'review-record-cap'));
  assert.equal(nextActions.includes(supplement), false, 'the hint is the one dropped by the cap');
  assert.equal(nextActionsDropped, 1);
  assert.ok(nextActions.length <= SELF_EVOLUTION_REVIEW_LIMITS.maxActions);
});
