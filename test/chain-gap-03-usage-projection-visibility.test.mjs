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
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  usageProducerScriptPath,
  usageProjectionRemediation,
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
  // Always relative to the reader's clock: a pinned calendar date would make
  // this suite fail once it passes the 30-day staleness bound.
  const doc = {
    kind: 'dsh-evolution-capability-usage',
    schemaVersion: 1,
    coverage: USAGE_PROJECTION_COVERAGE,
    source: 'session-evidence',
    complete: true,
    recordsComplete: true,
    capturedAt: new Date().toISOString(),
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
    { name: 'stale', setup: (env) => writeProjection(env, { capturedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() }), issue: 'stale', absentText: 'no usage projection has been written' },
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

test('the bounded-read notice and the supplement each keep a reserved slot', () => {
  const blockers = Array.from({ length: SELF_EVOLUTION_REVIEW_LIMITS.maxActions - 2 }, (_, index) => ({
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
  assert.ok(nextActions.includes(supplement));
  assert.equal(nextActionsDropped, 0);
  assert.ok(nextActions.length <= SELF_EVOLUTION_REVIEW_LIMITS.maxActions);

  // Over budget the supplement still survives, taking one slot from the lowest
  // priority blocker rather than disappearing with its executable command.
  const crowded = Array.from({ length: SELF_EVOLUTION_REVIEW_LIMITS.maxActions }, (_, index) => ({
    action: REVIEW_ACTIONS.VERIFY_HOST,
    recordId: `crowded-${index}`,
    why: 'blocking',
  }));
  const over = boundedReviewActions([...crowded, capNotice, supplement]);
  assert.ok(over.nextActions.includes(supplement));
  assert.ok(over.nextActions.some((row) => row.code === 'review-record-cap'));
  assert.equal(over.nextActions.length, SELF_EVOLUTION_REVIEW_LIMITS.maxActions);
  assert.ok(over.nextActionsDropped > 0);
});

test('doctor stays ok for absent projection with no records, but degrades a damaged one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-gap-03-empty-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: root });
  fs.mkdirSync(path.join(paths.dataRoot, 'shared-plugins'), { recursive: true });
  fs.writeFileSync(path.join(paths.dataRoot, 'shared-plugins', 'published.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt: new Date().toISOString(),
    publisher: { profile: 'desktop' },
    plugins: [],
  })}\n`);
  const absentReport = await collectDiagnostics({ home: root, paths });
  assert.equal(absentReport.checks.find((row) => row.id === 'promotion.usage').level, 'ok');

  fs.writeFileSync(path.join(paths.dataRoot, 'shared-plugins', 'usage.json'), '{ broken');
  const damagedReport = await collectDiagnostics({ home: root, paths });
  const check = damagedReport.checks.find((row) => row.id === 'promotion.usage');
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.status, 'invalid');
  // A valid empty index is a normal Desktop-only install: the producer can
  // converge, so the regular supplement command is the right guidance.
  assert.match(check.remediation, /capability-usage\.mjs/);

  // A genuinely absent index cannot converge: guidance must say restore it.
  fs.rmSync(path.join(paths.dataRoot, 'shared-plugins', 'published.json'));
  const noIndexReport = await collectDiagnostics({ home: root, paths });
  const noIndexCheck = noIndexReport.checks.find((row) => row.id === 'promotion.usage');
  assert.equal(noIndexCheck.level, 'degraded');
  assert.doesNotMatch(noIndexCheck.remediation, /capability-usage\.mjs/);
  assert.match(noIndexCheck.remediation, /publication index/);
  fs.rmSync(path.join(paths.dataRoot, 'shared-plugins', 'usage.json'));
  const repaired = await collectDiagnostics({ home: root, paths });
  assert.equal(repaired.checks.find((row) => row.id === 'promotion.usage').level, 'ok');
});

test('a non-boolean completeness flag is damage, not an implicit true', async (t) => {
  const env = await fixture(t, 'flag-type');
  await writeProjection(env, { complete: 'false' });
  const { loaded, stable } = await reviewed(env);
  assert.equal(loaded.evidence.status, 'invalid');
  assert.equal(loaded.evidence.reason, 'complete-type');
  assert.deepEqual(usageActions(stable).map((row) => row.code), [`${USAGE_PROJECTION_ACTION_PREFIX}invalid`]);
  const check = await doctorUsage(env);
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.reason, 'complete-type');
});

test('a projection that omits a published record is incomplete, not complete', async (t) => {
  const env = await fixture(t, 'missing-row');
  // A snapshot taken before a later publication can still say complete=true
  // with a fresh capture time; the missing row must be caught by cross-checking
  // the record ids the review actually reads.
  await writeProjection(env, { records: {} });
  const { stable } = await reviewed(env);
  const actions = usageActions(stable);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].issues, ['incomplete']);
  assert.equal(actions[0].missingRecordCount, 1);
  const check = await doctorUsage(env);
  assert.equal(check.level, 'degraded');
  assert.deepEqual(check.evidence.issues, ['incomplete']);
  assert.equal(check.evidence.missingRecordCount, 1);
});

test('an unreadable projection is invalid, not absent', async (t) => {
  // Reader level: ENOTDIR must not be reported as the benign absent shape.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-gap-03-unreadable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'shared-plugins'), 'not a directory');
  const loaded = await readUsageProjection({ dataRoot: root });
  assert.equal(loaded.evidence.status, 'invalid');
  assert.equal(loaded.evidence.reason, 'unreadable');

  // Review level: an invalid status on a data root that still has a published
  // record must produce the invalid supplement, not silently vanish.
  const env = await fixture(t, 'unreadable-review');
  const stable = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage: null, usageStatus: 'invalid' });
  const actions = usageActions(stable);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].code, `${USAGE_PROJECTION_ACTION_PREFIX}invalid`);
});

test('the supplement is not a blocking stable issue and does not block experience', () => {
  const supplement = {
    action: REVIEW_ACTIONS.OPERATOR,
    code: `${USAGE_PROJECTION_ACTION_PREFIX}absent`,
    recordId: null,
    why: 'no usage projection',
  };
  const composed = composeSelfEvolutionReview({
    stable: { status: 'active', nextActions: [supplement] },
    experience: {
      available: true,
      selected: { problemKey: 'problem:unrelated', occurrences: 2, expectedImprovement: 'smaller fix', requiresNewHypothesis: false },
    },
    versions: {},
  });
  assert.equal(composed.primary, REVIEW_ACTIONS.OPERATOR);
  assert.equal(composed.hasBlockingStableIssue, false);
  const experience = composed.nextActions.find((action) => action.action === REVIEW_ACTIONS.EXPERIENCE);
  assert.equal(experience.blockedBy, undefined);
});

test('the supplement command targets the inspected data root, not the default one', async (t) => {
  const env = await fixture(t, 'data-root-command');
  const reviewActions = usageActions(await readPublishedPluginReview({
    paths: env.paths, host: HOST, usage: null, usageStatus: 'absent',
  }));
  assert.equal(reviewActions.length, 1);
  const quotedRoot = `'${env.paths.dataRoot}'`;
  assert.ok(reviewActions[0].command.includes(`--data-root ${quotedRoot}`), reviewActions[0].command);
  const check = await doctorUsage(env);
  assert.ok(check.remediation.includes(`--data-root ${quotedRoot}`), check.remediation);

  // The documented producer really honours the flag it is told to copy.
  const alternate = path.join(env.home, 'alternate-root');
  fs.mkdirSync(path.join(alternate, 'shared-plugins'), { recursive: true });
  const script = fileURLToPath(new URL('../docs/audit/replay/capability-usage.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--home', env.home, '--data-root', alternate, '--write'], { encoding: 'utf8' });
  // The alternate root has no publication index, so the producer documents an
  // incomplete scan with exit 3; the projection is still written there.
  assert.ok(run.status === 0 || run.status === 3, run.stderr);
  assert.equal(fs.existsSync(path.join(alternate, 'shared-plugins', 'usage.json')), true);
  assert.equal(fs.existsSync(path.join(env.paths.dataRoot, 'shared-plugins', 'usage.json')), false);
});

test('the supplement command does not let a shell expand a literal $USER in the data root', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-gap-03-shell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "O'Brien-home");
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const assessments = path.join(root, "O'Brien-assessments.json");
  fs.writeFileSync(assessments, '{}');
  const dataRoot = path.join(root, 'storages', '$USER-root');
  fs.mkdirSync(path.join(dataRoot, 'shared-plugins'), { recursive: true });
  const command = usageProjectionRemediation({ scriptPath: usageProducerScriptPath(), dataRoot }).command;
  assert.ok(command.includes(`--data-root '${dataRoot}'`), command);
  assert.ok(command.includes('--home "${DSH_HOME:?'), command);
  assert.ok(command.includes('--assessments "${ASSESSMENTS_FILE:?'), command);
  // Missing required variables must abort before anything is written.
  const unset = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: '', ASSESSMENTS_FILE: '' },
  });
  assert.notEqual(unset.status, 0);
  assert.equal(fs.existsSync(path.join(dataRoot, 'shared-plugins', 'usage.json')), false);
  const run = spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, ASSESSMENTS_FILE: assessments },
  });
  assert.ok(run.status === 0 || run.status === 3, run.stderr);
  assert.equal(fs.existsSync(path.join(dataRoot, 'shared-plugins', 'usage.json')), true);
});

test('restart suggestions cannot crowd out the only usage supplement', () => {
  const restarts = Array.from({ length: SELF_EVOLUTION_REVIEW_LIMITS.maxActions }, (_, index) => ({
    action: REVIEW_ACTIONS.RESTART,
    recordId: `record-${index}`,
    why: 'restart',
  }));
  const supplement = {
    action: REVIEW_ACTIONS.OPERATOR,
    code: `${USAGE_PROJECTION_ACTION_PREFIX}absent`,
    recordId: null,
    why: 'no usage projection',
  };
  const { nextActions, nextActionsDropped } = boundedReviewActions([...restarts, supplement]);
  assert.ok(nextActions.includes(supplement), JSON.stringify(nextActions.map((row) => row.code ?? row.action)));
  assert.equal(nextActionsDropped, 1);
  assert.ok(nextActions.length <= SELF_EVOLUTION_REVIEW_LIMITS.maxActions);
});

test('a damaged projection is surfaced even with an empty or absent index', async (t) => {
  const env = await fixture(t, 'empty-index-damaged');
  const shared = sharingPaths(env.paths);
  const index = JSON.parse(fs.readFileSync(shared.indexPath, 'utf8'));
  index.plugins = [];
  fs.writeFileSync(shared.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  fs.writeFileSync(shared.usagePath, '{ broken');
  const emptyReview = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage: null, usageStatus: 'invalid' });
  assert.equal(usageActions(emptyReview).length, 1);
  assert.equal(usageActions(emptyReview)[0].code, `${USAGE_PROJECTION_ACTION_PREFIX}invalid`);
  assert.equal((await doctorUsage(env)).level, 'degraded');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-gap-03-absent-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveEvolutionPaths({ dshHome: root });
  fs.mkdirSync(path.join(paths.dataRoot, 'shared-plugins'), { recursive: true });
  await writeUsageProjection({ dataRoot: paths.dataRoot, projection: {
    kind: 'dsh-evolution-capability-usage', schemaVersion: 1,
    coverage: USAGE_PROJECTION_COVERAGE, source: 'session-evidence',
    complete: true, recordsComplete: true, stale: false,
    capturedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    records: {},
  } });
  const loaded = await readUsageProjection({ dataRoot: paths.dataRoot });
  const absentReview = await readPublishedPluginReview({ paths, host: HOST, usage: loaded.usage, usageStatus: loaded.evidence.status });
  assert.equal(absentReview.status, 'absent');
  assert.equal(usageActions(absentReview).length, 1);
  const [action] = usageActions(absentReview);
  assert.equal(action.code, `${USAGE_PROJECTION_ACTION_PREFIX}stale`);
  assert.match(action.command, /capability-usage\.mjs/);
  assert.match(action.prerequisite, /Restore the shared publication index/);
  assert.match(action.why, /Remove the residual usage\.json|Desktop-only/);
});

test('a broken index and a damaged projection both stay visible', async (t) => {
  const env = await fixture(t, 'both-broken');
  fs.writeFileSync(sharingPaths(env.paths).indexPath, '{ broken');
  fs.writeFileSync(sharingPaths(env.paths).usagePath, '{ broken');
  const review = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage: null, usageStatus: 'invalid' });
  assert.equal(review.status, 'blocked');
  assert.equal(review.reason, 'publication-index-unreadable');
  assert.ok(review.nextActions.some((row) => /publication index is invalid/.test(row.why)),
    JSON.stringify(review.nextActions));
  assert.deepEqual(usageActions(review).map((row) => row.code), [`${USAGE_PROJECTION_ACTION_PREFIX}invalid`]);
  const composed = composeSelfEvolutionReview({ stable: review });
  assert.equal(composed.hasBlockingStableIssue, true);
  assert.ok(usageActions(composed).length > 0);
});

test('doctor never copies raw capturedAt text into a report', async (t) => {
  const env = await fixture(t, 'captured-at');
  await writeProjection(env, { capturedAt: 'PRIVATE <owner@example.com> not-a-date' });
  const check = await doctorUsage(env);
  assert.equal(check.level, 'degraded');
  assert.equal(check.evidence.capturedAt, null);
  assert.equal(JSON.stringify(check).includes('PRIVATE'), false);
});
