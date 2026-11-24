// Read-only unified self-evolution review (lib/self-evolution-review.js).
//
// A self-evolution request starts from one read-only review: previously
// published stable plugins are re-checked against this host, then the existing
// evidence-ranked experience plan is composed into ordered next actions.
//
// Every fixture is synthesized under a fresh os.tmpdir() root with the same
// promoted-plugin bytes, publication record, consumer state and revocation
// table the real contract reads; nothing here touches a real DSH home, a real
// promotion or operator data. The review must never write: the read-only test
// snapshots every byte under the data root before and after it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildSharedRecord,
  consumerStateDocument,
  hostDigest,
  publishSharedRecord,
  readSharedIndex,
  setDisabledForProfile,
  sharingPaths,
  writeConsumerState,
} from '../lib/promoted-sharing.js';
import {
  composeSelfEvolutionReview,
  orderStableActions,
  readPublishedPluginReview,
  reviewExperience,
  REVIEW_ACTIONS,
} from '../lib/self-evolution-review.js';
import { openSharedExperience } from '../lib/shared-experience.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SCRIPT = path.resolve(fileURLToPath(new URL('../scripts/shared-plugins.mjs', import.meta.url)));

// The identity a promotion was verified on and the live host of the review.
const CURRENT_HOST = Object.freeze({
  profile: 'desktop',
  dsh: '0.2.2-rc.2',
  cordis: '4.1.0',
  include: '1.1.0',
  node: 'v24.21.0',
  capturedAt: '2026-01-01T00:00:00.000Z',
});
const PREVIOUS_HOST = Object.freeze({ ...CURRENT_HOST, dsh: '0.2.2-rc.1' });
const CAPABILITIES = Object.freeze({ fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true });
const PROFILES = Object.freeze(['acp', 'web']);
const RECORD_SUFFIX = 'abcdefabcdef';
const RECORD_ID = `evolution-promoted-${RECORD_SUFFIX}`;
const PLUGIN_NAME = `dsh-${RECORD_ID}`;

async function scratch(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-self-review-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** One real promoted plugin, its stable facts and the data root they live in. */
async function fixture(t, name, { recordHost = CURRENT_HOST, experimentId = `exp-review-${name}` } = {}) {
  const root = await scratch(t, name);
  const paths = {
    dataRoot: root,
    presetDir: root,
    pluginRoot: path.join(root, 'promoted'),
  };
  const pluginDir = path.join(paths.pluginRoot, PLUGIN_NAME);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = `export const name = ${JSON.stringify(PLUGIN_NAME)};\nexport const inject = [];\nexport function apply() {}\n`;
  await fs.writeFile(modulePath, source);
  await fs.writeFile(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0', private: true, type: 'module', main: 'lib/index.js' }, null, 2)}\n`,
  );
  const durable = {
    pluginName: PLUGIN_NAME,
    pluginPath: pluginDir,
    moduleUrl: pathToFileURL(modulePath).href,
    rowId: RECORD_ID,
  };
  const experiment = {
    id: experimentId,
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
    decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
    durable,
  };
  const record = await buildSharedRecord({
    paths,
    experiment,
    durable,
    journal: null,
    approvedProfiles: experiment.shareTargets,
    host: recordHost,
    capabilities: CAPABILITIES,
    source: { stableCommittedAt: experiment.stableCommittedAt },
  });
  const outcome = await publishSharedRecord(paths, record);
  assert.equal(outcome.status, 'published', 'the fixture must publish one stable record');
  // The durable promotion evidence is part of a real stable record; write the
  // paired comparison it would carry so the value classification has a real
  // basis. Tests that need a self-test or a missing sidecar overwrite/remove it.
  await writeEvidenceFile(paths.dataRoot, experimentId, {
    solvesProblem: true,
    probeDerived: true,
    probe: { comparison: { benefit: true, benefitKind: 'workflow', workflowBenefit: true, workload: { id: 'fixture-workflow' } } },
    observationWindow: 'probe:fixture-workflow',
  });
  const index = await readSharedIndex(paths);
  assert.equal(index.status, 'ok');
  return { root, paths, pluginDir, modulePath, source, durable, experiment, record, index };
}

/** Write one promotion evidence sidecar into the data root the review reads. */
async function writeEvidenceFile(dataRoot, experimentId, observation) {
  const dir = path.join(dataRoot, 'archive', 'experiments');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${experimentId}.evidence.json`), `${JSON.stringify({
    version: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    latestObservation: observation,
    observations: [observation],
    decision: { kind: 'benefit' },
  }, null, 2)}\n`);
}

/** Write the consumer activation record every profile would report after one start. */
async function writeConsumers(env, {
  host = CURRENT_HOST,
  observedIndexUpdatedAt = env.index.updatedAt,
  rows = null,
} = {}) {
  const digest = hostDigest(host);
  for (const profile of PROFILES) {
    const plugins = rows?.[profile] ?? [{
      id: env.record.id,
      status: 'active',
      reason: null,
      hostDigest: digest,
      activatedAt: '2026-01-04T00:00:00.000Z',
    }];
    await writeConsumerState(env.paths, profile, consumerStateDocument({
      profile,
      host,
      indexUpdatedAt: observedIndexUpdatedAt,
      compositionPath: null,
      plugins,
    }));
  }
}

function review(env, host = CURRENT_HOST) {
  return readPublishedPluginReview({ paths: env.paths, host });
}

/** Exact bytes (and the directory shape) under one root, for a read-only proof. */
async function snapshotTree(root) {
  const entries = [];
  async function walk(directory) {
    const dirents = await fs.readdir(directory, { withFileTypes: true });
    for (const dirent of dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const full = path.join(directory, dirent.name);
      const rel = path.relative(root, full);
      if (dirent.isDirectory()) {
        entries.push({ rel, type: 'dir' });
        await walk(full);
      } else if (dirent.isFile()) {
        const bytes = await fs.readFile(full);
        entries.push({ rel, type: 'file', size: bytes.length, digest: sha256(bytes) });
      } else if (dirent.isSymbolicLink()) {
        entries.push({ rel, type: 'link', target: await fs.readlink(full) });
      } else {
        entries.push({ rel, type: 'other' });
      }
    }
  }
  await walk(root);
  return entries;
}

// ---------------------------------------------------------------------------
// Stable-plugin classification
// ---------------------------------------------------------------------------

test('an unchanged index and active consumers classify the record as active with no next action', async (t) => {
  const env = await fixture(t, 'active');
  await writeConsumers(env);

  const result = await review(env);
  assert.equal(result.status, 'active');
  assert.equal(result.indexStatus, 'ok');
  assert.equal(result.indexUpdatedAt, env.index.updatedAt);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.active, 1);
  assert.deepEqual(result.nextActions, []);

  const [record] = result.records;
  assert.equal(record.id, RECORD_ID);
  assert.equal(record.status, 'active');
  assert.equal(record.action, null);
  assert.equal(record.source, 'verified');
  assert.equal(record.hostCompatible, true);
  assert.deepEqual(record.reasons, []);
  assert.deepEqual(record.profiles.map((row) => row.status), ['active', 'active']);
  assert.deepEqual(result.consumers.acp.rows.map((row) => row.status), ['active']);

  // A review with nothing to fix composes to an explicit no-action result.
  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'no-action');
  assert.equal(composed.primary, REVIEW_ACTIONS.NONE);
  assert.equal(composed.hasBlockingStableIssue, false);
});

test('a host-version mismatch is revalidated, not repaired or re-promoted', async (t) => {
  const env = await fixture(t, 'host-mismatch', { recordHost: PREVIOUS_HOST });
  await writeConsumers(env);

  const result = await review(env);
  assert.equal(result.status, 'pending-revalidation');
  assert.equal(result.summary.pendingRevalidation, 1);
  assert.equal(result.nextActions.length, 1);

  const [record] = result.records;
  assert.equal(record.status, 'pending-revalidation');
  assert.equal(record.action, REVIEW_ACTIONS.REVALIDATE);
  assert.equal(record.hostCompatible, false);
  assert.equal(record.hostReason, 'host-version-mismatch');
  assert.equal(record.host.dsh, PREVIOUS_HOST.dsh);

  const [action] = result.nextActions;
  assert.equal(action.action, REVIEW_ACTIONS.REVALIDATE);
  assert.equal(action.recordId, RECORD_ID, 'the action names the exact record');
  assert.ok(action.command.includes(SCRIPT), 'the shipped verification script is the command');
  assert.match(action.command, /revalidate --evidence/);
  assert.ok(action.why.includes(PREVIOUS_HOST.dsh));
  assert.ok(action.forbidden.some((entry) => /edit or regenerate/.test(entry)));
  assert.equal(action.rootCauseHint, undefined);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'revalidate');
  assert.equal(composed.primary, REVIEW_ACTIONS.REVALIDATE);
});

test('a current-host consumer apply failure is incompatible and asks for the smallest repair', async (t) => {
  const env = await fixture(t, 'incompatible');
  const digest = hostDigest(CURRENT_HOST);
  await writeConsumers(env, {
    rows: {
      acp: [{ id: RECORD_ID, status: 'failed', reason: 'plugin-apply-failed', hostDigest: digest }],
      web: [{ id: RECORD_ID, status: 'active', reason: null, hostDigest: digest }],
    },
  });

  const result = await review(env);
  assert.equal(result.status, 'incompatible');
  assert.equal(result.summary.incompatible, 1);
  assert.equal(result.nextActions.length, 1);

  const [record] = result.records;
  assert.equal(record.status, 'incompatible');
  assert.equal(record.action, REVIEW_ACTIONS.REPAIR);
  assert.ok(record.reasons.some((reason) => /acp: apply-failed \(plugin-apply-failed\)/.test(reason)));

  const [action] = result.nextActions;
  assert.equal(action.action, REVIEW_ACTIONS.REPAIR);
  assert.equal(action.recordId, RECORD_ID);
  assert.match(action.rootCauseHint, /smallest fix/);
  assert.equal(action.command, undefined, 'a failed stable plugin is never remounted or revalidated blindly');

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'repair-stable');
  assert.equal(composed.primary, REVIEW_ACTIONS.REPAIR);
});

test('a changed plugin source is source-unusable and never gets mount advice', async (t) => {
  const env = await fixture(t, 'source-mismatch');
  await writeConsumers(env);
  // Verified bytes are the publication identity: a local edit must be reported,
  // not adopted as the current plugin.
  await fs.appendFile(env.modulePath, '\n// modified after publication\n');

  const result = await review(env);
  assert.equal(result.status, 'blocked');
  assert.equal(result.summary.sourceUnusable, 1);
  assert.equal(result.summary.active, 0);

  const [record] = result.records;
  assert.equal(record.status, 'source-unusable');
  assert.equal(record.action, REVIEW_ACTIONS.OPERATOR);
  assert.equal(record.source, 'source-digest-mismatch');
  assert.ok(record.reasons.some((reason) => /plugin bytes differ/.test(reason)));

  const [action] = result.nextActions;
  assert.equal(action.action, REVIEW_ACTIONS.OPERATOR);
  assert.equal(action.recordId, RECORD_ID);
  assert.equal(action.command, undefined);
  assert.deepEqual(Object.keys(action).sort(), ['action', 'recordId', 'why']);
  assert.equal(JSON.stringify(result).includes('revalidate --evidence'), false, 'no revalidation advice for damaged bytes');
});

test('a live host identity that cannot be proven is verify-host, not a false revalidation', async (t) => {
  const env = await fixture(t, 'verify-host');
  await writeConsumers(env);
  // The ACP fallback can still fail to prove the official package identity.
  // A missing version must never be read as "compatible" or as a pending
  // revalidation of the recorded host: the record stays unverified.
  const unproven = { profile: 'acp', dsh: null, cordis: null, include: null, node: process.version };

  const result = await review(env, unproven);
  assert.equal(result.status, 'verify-host');
  assert.equal(result.summary.verifyHost, 1);
  assert.equal(result.summary.pendingRevalidation, 0);
  assert.equal(result.nextActions.length, 1);

  const [record] = result.records;
  assert.equal(record.status, 'verify-host');
  assert.equal(record.action, REVIEW_ACTIONS.VERIFY_HOST);
  assert.ok(record.reasons.some((reason) => /live host identity is unavailable/.test(reason)));
  assert.equal(record.profiles.length, 0, 'no profile is judged against an unproven host');

  const [action] = result.nextActions;
  assert.equal(action.action, REVIEW_ACTIONS.VERIFY_HOST);
  assert.equal(action.recordId, RECORD_ID);
  assert.equal(action.command, undefined);

  const composed = composeSelfEvolutionReview({ stable: result, experience: plannedExperience(), versions: CURRENT_HOST });
  assert.equal(composed.kind, 'verify-host');
  assert.equal(composed.primary, REVIEW_ACTIONS.VERIFY_HOST);
  assert.equal(composed.hasBlockingStableIssue, true);
  assert.deepEqual(composed.nextActions.at(-1).blockedBy, [RECORD_ID]);
});

test('operator-disabled for every approved profile is inactive with no next action', async (t) => {
  const env = await fixture(t, 'disabled');
  // Every consumer has already unmounted the record, so revocation needs no
  // further action. Active rows after revocation are covered separately below.
  await writeConsumers(env, { rows: { acp: [], web: [] } });
  for (const profile of PROFILES) {
    const outcome = await setDisabledForProfile(env.paths, { pluginId: RECORD_ID, profile, disabled: true, reason: 'operator test' });
    assert.equal(outcome.ok, true);
  }

  const result = await review(env);
  assert.equal(result.status, 'inactive');
  assert.equal(result.summary.inactive, 1);
  assert.equal(result.summary.active, 0);
  assert.deepEqual(result.nextActions, []);

  const [record] = result.records;
  assert.equal(record.status, 'inactive');
  assert.equal(record.action, null);
  assert.deepEqual(record.profiles.map((row) => row.status), ['disabled', 'disabled']);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'no-action');
});

test('a record disabled for one profile needs a restart while that consumer still mounts it', async (t) => {
  const env = await fixture(t, 'partial-disabled');
  await writeConsumers(env);
  const outcome = await setDisabledForProfile(env.paths, { pluginId: RECORD_ID, profile: 'acp', disabled: true, reason: 'operator test' });
  assert.equal(outcome.ok, true);

  const result = await review(env);
  assert.equal(result.status, 'restart-required');
  assert.equal(result.nextActions.length, 1);
  assert.equal(result.nextActions[0].action, REVIEW_ACTIONS.RESTART);

  const [record] = result.records;
  assert.deepEqual(record.profiles.map((row) => row.status).sort(), ['active', 'restart-required']);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'restart-consumer');
});

test('an invalid published record surfaces an operator action instead of a silent no-action', async (t) => {
  const env = await fixture(t, 'invalid-mixed');
  await writeConsumers(env);
  const indexPath = sharingPaths(env.paths).indexPath;
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.plugins.push({ id: 'evolution-promoted-000000000000', schemaVersion: 1 });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const result = await review(env);
  assert.equal(result.indexStatus, 'ok');
  assert.equal(result.summary.invalid, 1);
  assert.equal(result.summary.active, 1);
  assert.equal(result.status, 'blocked');
  assert.ok(result.invalidRecords.some((row) => typeof row.reason === 'string' && row.reason !== ''));
  const operator = result.nextActions.find((row) => row.action === REVIEW_ACTIONS.OPERATOR && /failed validation/.test(row.why));
  assert.ok(operator, `the invalid record did not get an operator action: ${JSON.stringify(result.nextActions)}`);
  assert.equal(operator.recordId, 'evolution-promoted-000000000000');

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'operator-action');
});
test('a consumer whose index moved since it started needs a restart, not a source change', async (t) => {
  const env = await fixture(t, 'restart');
  await writeConsumers(env, { observedIndexUpdatedAt: '2020-01-01T00:00:00.000Z' });

  const result = await review(env);
  assert.equal(result.status, 'restart-required');
  assert.equal(result.summary.restartRequired, 1);
  assert.equal(result.summary.active, 0);
  assert.equal(result.nextActions.length, 1);

  const [record] = result.records;
  assert.equal(record.status, 'restart-required');
  assert.equal(record.action, REVIEW_ACTIONS.RESTART);
  assert.ok(record.reasons.some((reason) => /index-changed-since-consumer-start/.test(reason)));

  const [action] = result.nextActions;
  assert.equal(action.action, REVIEW_ACTIONS.RESTART);
  assert.equal(action.command, undefined);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'restart-consumer');
});

test('an absent index is a normal Desktop-only install: status absent, no action', async (t) => {
  const root = await scratch(t, 'absent');
  const paths = { dataRoot: root, presetDir: root, pluginRoot: path.join(root, 'promoted') };

  const result = await readPublishedPluginReview({ paths, host: CURRENT_HOST });
  assert.equal(result.status, 'absent');
  assert.equal(result.reason, 'no published stable plugin');
  assert.equal(result.indexStatus, 'absent');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.nextActions, []);
  assert.equal(result.readOnly, true);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'no-action');
});

for (const { label, title, prepare } of [
  {
    label: 'invalid',
    title: 'an invalid publication index is an operator action, never a guessed mount',
    prepare: async (indexPath) => {
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(indexPath, '{not-json');
    },
  },
  {
    label: 'unreadable',
    title: 'an unreadable publication index is an operator action, never a guessed mount',
    prepare: async (indexPath) => {
      await fs.mkdir(indexPath, { recursive: true });
    },
  },
]) {
  test(title, async (t) => {
    const root = await scratch(t, `index-${label}`);
    const paths = { dataRoot: root, presetDir: root, pluginRoot: path.join(root, 'promoted') };
    await prepare(sharingPaths(paths).indexPath);

    const result = await readPublishedPluginReview({ paths, host: CURRENT_HOST });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'publication-index-unreadable');
    assert.equal(result.indexStatus, label);
    assert.equal(result.summary.blocked, 1);
    assert.equal(result.nextActions.length, 1);
    assert.equal(result.nextActions[0].action, REVIEW_ACTIONS.OPERATOR);
    assert.equal(result.nextActions[0].recordId, null);
    assert.equal(result.nextActions[0].command, undefined);

    const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
    assert.equal(composed.kind, 'operator-action');
    assert.equal(composed.primary, REVIEW_ACTIONS.OPERATOR);
  });
}

test('the review is read-only: every byte under the data root is unchanged', async (t) => {
  const env = await fixture(t, 'read-only');
  await writeConsumers(env);
  const before = await snapshotTree(env.root);
  assert.ok(before.some((entry) => entry.rel.endsWith('published.json')), 'the fixture must contain the publication index');
  assert.ok(before.some((entry) => entry.rel.endsWith('lib/index.js')), 'the fixture must contain real plugin bytes');

  const first = await review(env);
  assert.equal(first.records[0].status, 'active');
  // A second pass must also stay a pure read.
  const second = await review(env);
  assert.deepEqual(second.records, first.records);

  const after = await snapshotTree(env.root);
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// Composition priority and the experience half
// ---------------------------------------------------------------------------

function plannedExperience(overrides = {}) {
  return {
    available: true,
    selected: {
      problemKey: 'tool edge-cache',
      occurrences: 3,
      expectedImprovement: 'successRate up; the control must not regress',
      requiresNewHypothesis: false,
    },
    candidates: [{ problemKey: 'tool edge-cache' }],
    none: null,
    errors: [],
    ...overrides,
  };
}

test('composition orders operator/revalidate/repair/restart before a new experience candidate', () => {
  const stable = {
    status: 'incompatible',
    nextActions: [
      { action: REVIEW_ACTIONS.RESTART, recordId: `evolution-promoted-444444444444`, why: 'restart' },
      { action: REVIEW_ACTIONS.REPAIR, recordId: `evolution-promoted-333333333333`, why: 'repair' },
      { action: REVIEW_ACTIONS.REVALIDATE, recordId: `evolution-promoted-222222222222`, why: 'revalidate' },
      { action: REVIEW_ACTIONS.VERIFY_HOST, recordId: `evolution-promoted-555555555555`, why: 'verify host' },
      { action: REVIEW_ACTIONS.OPERATOR, recordId: null, why: 'operator' },
    ],
  };
  const composed = composeSelfEvolutionReview({ stable, experience: plannedExperience(), versions: CURRENT_HOST });
  assert.equal(composed.kind, 'operator-action', 'a blocked fact outranks every actionable fix');
  assert.equal(composed.primary, REVIEW_ACTIONS.OPERATOR);
  assert.equal(composed.hasBlockingStableIssue, true);
  assert.deepEqual(composed.nextActions.map((entry) => entry.action), [
    REVIEW_ACTIONS.OPERATOR,
    REVIEW_ACTIONS.VERIFY_HOST,
    REVIEW_ACTIONS.REVALIDATE,
    REVIEW_ACTIONS.REPAIR,
    REVIEW_ACTIONS.RESTART,
    REVIEW_ACTIONS.EXPERIENCE,
  ]);
  // Only the actions that already block real use are named; a plain consumer
  // restart is not a blocker for a new experiment.
  const blocked = composeSelfEvolutionReview({
    stable: {
      nextActions: [
        { action: REVIEW_ACTIONS.RESTART, recordId: 'evolution-promoted-444444444444', why: 'restart' },
        { action: REVIEW_ACTIONS.REPAIR, recordId: `evolution-promoted-333333333333`, why: 'repair' },
        { action: REVIEW_ACTIONS.REVALIDATE, recordId: `evolution-promoted-222222222222`, why: 'revalidate' },
      ],
    },
    experience: plannedExperience(),
    versions: CURRENT_HOST,
  });
  const experienceAction = blocked.nextActions.at(-1);
  assert.equal(experienceAction.action, REVIEW_ACTIONS.EXPERIENCE);
  assert.deepEqual(
    [...experienceAction.blockedBy].sort(),
    [`evolution-promoted-222222222222`, `evolution-promoted-333333333333`].sort(),
    'the experience candidate is explicitly blocked by the stable actions that already block use',
  );

  // Without a stable issue the same candidate becomes the primary action.
  const alone = composeSelfEvolutionReview({ stable: { nextActions: [] }, experience: plannedExperience(), versions: CURRENT_HOST });
  assert.equal(alone.kind, 'experience-candidate');
  assert.equal(alone.primary, REVIEW_ACTIONS.EXPERIENCE);
  assert.equal(alone.hasBlockingStableIssue, false);
  assert.equal(alone.nextActions[0].blockedBy, undefined);
});

test('the review carries the planner capability form and observed baseline', () => {
  const experience = plannedExperience({
    selected: {
      problemKey: 'tool read',
      occurrences: 9,
      expectedImprovement: 'fewer recovery calls',
      improvement: 'context-policy',
      verificationKind: 'paired-real-session',
      baselinePath: { kind: 'observed-recovery', recoveryTools: ['bash', 'run_code'], recoveryCalls: 3 },
    },
  });
  const composed = composeSelfEvolutionReview({ stable: { nextActions: [] }, experience, versions: CURRENT_HOST });
  const [action] = composed.nextActions;
  assert.equal(action.improvement, 'context-policy');
  assert.equal(action.verificationKind, 'paired-real-session');
  assert.deepEqual(action.baselineRecoveryTools, ['bash', 'run_code']);

  // A merged target's per-kind evidence travels with the action: an existing
  // capability for one read loss must not read as covering the other.
  const withKinds = composeSelfEvolutionReview({
    stable: { nextActions: [] },
    experience: plannedExperience({
      selected: {
        problemKey: 'tool read',
        occurrences: 5,
        expectedImprovement: 'fewer recovery calls',
        improvement: 'context-policy',
        verificationKind: 'paired-real-session',
        baselinePath: { kind: 'observed-recovery', recoveryTools: ['run_code'], recoveryCalls: 5 },
        loss: {
          kinds: ['line-truncated', 'output-capped'],
          breakdown: [
            { kind: 'line-truncated', occurrences: 3, recoveryCalls: 3, recoveryTools: ['bash'] },
            { kind: 'output-capped', occurrences: 2, recoveryCalls: 2, recoveryTools: ['run_code'] },
          ],
        },
      },
    }),
    versions: CURRENT_HOST,
  });
  assert.deepEqual(withKinds.nextActions[0].lossKinds, [
    { kind: 'line-truncated', occurrences: 3, recoveryCalls: 3, recoveryTools: ['bash'] },
    { kind: 'output-capped', occurrences: 2, recoveryCalls: 2, recoveryTools: ['run_code'] },
  ]);

  // An unknown form is not silently promoted into a proposal contract.
  const unknown = composeSelfEvolutionReview({
    stable: { nextActions: [] },
    experience: plannedExperience({
      selected: {
        problemKey: 'tool read', occurrences: 3, improvement: 'unknown-form',
        baselinePath: { kind: 'observed-recovery', recoveryTools: ['bash'] },
      },
    }),
    versions: CURRENT_HOST,
  });
  assert.equal(unknown.nextActions[0].improvement, undefined);
  assert.equal(unknown.nextActions[0].baselineRecoveryTools, undefined);
});

test('a blocking action is never dropped by the bounded action list', () => {
  const actions = Array.from({ length: 12 }, (_, index) => ({
    action: REVIEW_ACTIONS.RESTART,
    recordId: `evolution-promoted-${String(index).padStart(12, '0')}`,
    why: 'stale consumer',
  }));
  actions.push({ action: REVIEW_ACTIONS.OPERATOR, recordId: 'evolution-promoted-ffffffffffff', why: 'damaged source' });

  const ordered = orderStableActions(actions);
  assert.equal(ordered[0].action, REVIEW_ACTIONS.OPERATOR, 'the blocking action must sort ahead of the restart actions');
  assert.equal(ordered.length, 13);

  const composed = composeSelfEvolutionReview({
    stable: { status: 'blocked', nextActions: ordered.slice(0, 12), nextActionsDropped: 1 },
    experience: null,
    versions: CURRENT_HOST,
  });
  assert.equal(composed.kind, 'operator-action');
  assert.equal(composed.incomplete, true, 'dropped actions make the review explicitly incomplete');
  assert.equal(composed.stable.nextActionsDropped, 1);
});
test('revalidation outranks repair, and repair outranks an experience candidate', () => {
  const revalidate = { action: REVIEW_ACTIONS.REVALIDATE, recordId: 'evolution-promoted-aaaaaaaaaaaa', why: 'host changed' };
  const repair = { action: REVIEW_ACTIONS.REPAIR, recordId: 'evolution-promoted-bbbbbbbbbbbb', why: 'apply failed' };

  const revalidateFirst = composeSelfEvolutionReview({
    stable: { nextActions: [repair, revalidate] },
    experience: plannedExperience(),
    versions: CURRENT_HOST,
  });
  assert.equal(revalidateFirst.kind, 'revalidate');
  assert.deepEqual(revalidateFirst.nextActions.map((entry) => entry.action),
    [REVIEW_ACTIONS.REVALIDATE, REVIEW_ACTIONS.REPAIR, REVIEW_ACTIONS.EXPERIENCE]);

  const repairFirst = composeSelfEvolutionReview({
    stable: { nextActions: [repair] },
    experience: plannedExperience(),
    versions: CURRENT_HOST,
  });
  assert.equal(repairFirst.kind, 'repair-stable');
  assert.deepEqual(repairFirst.nextActions.map((entry) => entry.action),
    [REVIEW_ACTIONS.REPAIR, REVIEW_ACTIONS.EXPERIENCE]);
  assert.deepEqual(repairFirst.nextActions[1].blockedBy, [repair.recordId]);
});

test('no stable signal and no experience candidate compose to no-action instead of inventing work', () => {
  const composed = composeSelfEvolutionReview({
    stable: { status: 'absent', nextActions: [] },
    experience: { available: true, selected: null, candidates: [], none: { reason: 'no-failure-signal' } },
    versions: { dsh: 'unknown', cordis: 'unknown', evolution: 'unknown' },
  });
  assert.equal(composed.kind, 'no-action');
  assert.equal(composed.primary, REVIEW_ACTIONS.NONE);
  assert.deepEqual(composed.nextActions, []);
  assert.equal(composed.hasBlockingStableIssue, false);
  assert.equal(composed.readOnly, true);
  assert.deepEqual(composed.experience.none, { reason: 'no-failure-signal' });
});

test('reviewExperience reuses the unified experience store and reports its absence explicitly', async (t) => {
  const root = await scratch(t, 'experience-store');
  const store = openSharedExperience(root);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const versions = { dsh: '1.30.0', cordis: '4.1.0', evolution: '0.3.0' };
  for (let index = 0; index < 3; index += 1) {
    store.recordFailure({
      id: sha256(`self-review-failure:${index}`),
      type: 'tool/error',
      code: 'E_TOOL_FAILED',
      target: 'tool:edge-cache',
    });
  }

  const planned = reviewExperience({ store, versions, now: Date.now() });
  assert.equal(planned.available, true);
  assert.ok(planned.selected, 'a seeded recurring failure must produce a selected candidate');
  assert.equal(planned.selected.problemKey, 'tool edge-cache');
  assert.equal(planned.selected.occurrences, 3);
  assert.equal(planned.none, null);
  assert.deepEqual(planned.applicability, versions);
  assert.equal(planned.applicabilityVerified, true);
  assert.equal(planned.sources.shared, 1);
  assert.deepEqual(planned.errors, []);
  assert.ok(Array.isArray(planned.candidates) && planned.candidates.length === 1);

  const unavailable = reviewExperience({ versions });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.selected, null);
  assert.deepEqual(unavailable.candidates, []);
  assert.equal(unavailable.none.reason, 'store-unavailable');
  assert.equal(unavailable.sources.shared, 0);
  assert.equal(unavailable.errors[0].reason, 'shared-experience-store-unavailable');
  assert.equal(unavailable.errors[0].errorCode, 'E_EVOLUTION_PLAN_NO_SHARED_STORE');
});

// A consumer row describes the profile's last boot. When the operator restores
// eligibility (enable, or approving a profile that was skipped) without
// restarting that entry, the stale row must be read as "restart this consumer",
// never as active/inactive with no action.
test('restored eligibility without a consumer restart is restart-required, not a false no-action', async (t) => {
  const env = await fixture(t, 'restored-eligibility');
  const digest = hostDigest(CURRENT_HOST);
  await writeConsumers(env, {
    rows: {
      acp: [{ id: env.record.id, status: 'disabled', reason: 'operator-disabled', hostDigest: digest, activatedAt: null }],
      web: [{ id: env.record.id, status: 'skipped-unapproved', reason: 'profile-not-approved', hostDigest: digest, activatedAt: null }],
    },
  });

  const result = await review(env);
  assert.equal(result.status, 'restart-required');
  const [record] = result.records;
  assert.equal(record.status, 'restart-required');
  assert.equal(record.action, REVIEW_ACTIONS.RESTART);
  assert.deepEqual(record.profiles.map((row) => row.status), ['restart-required', 'restart-required']);
  assert.deepEqual(result.nextActions.map((action) => action.action), [REVIEW_ACTIONS.RESTART]);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'restart-consumer');
  assert.equal(composed.hasBlockingStableIssue, false);
});

test('already-mounted and publisher-profile rows stay inactive instead of becoming a restart loop', async (t) => {
  const env = await fixture(t, 'sticky-disabled');
  const digest = hostDigest(CURRENT_HOST);
  await writeConsumers(env, {
    rows: {
      acp: [{ id: env.record.id, status: 'disabled', reason: 'already-mounted', hostDigest: digest, activatedAt: null }],
      web: [{ id: env.record.id, status: 'disabled', reason: 'publisher-profile', hostDigest: digest, activatedAt: null }],
    },
  });

  const result = await review(env);
  const [record] = result.records;
  assert.deepEqual(record.profiles.map((row) => row.status), ['disabled', 'disabled']);
  assert.equal(result.nextActions.some((action) => action.action === REVIEW_ACTIONS.RESTART), false);
});

// After an adopted revalidation the record already matches the live host while
// a consumer's state still carries the host from its previous start. That row
// is stale: the consumer must be restarted (new ACP session / Web entry) to
// pick up the compatible record. Asking for another revalidation here loops,
// because run-revalidation reports "nothing to revalidate" once the record's
// host already matches. A genuine host upgrade is different: there the RECORD
// itself is incompatible and the record-level check asks for revalidation
// before per-profile verdicts are computed.
test('a stale pending-revalidation row on a now-compatible record asks for a restart', async (t) => {
  const env = await fixture(t, 'consumer-host-mismatch');
  const staleDigest = hostDigest(PREVIOUS_HOST);
  await writeConsumers(env, {
    host: PREVIOUS_HOST,
    rows: {
      acp: [{ id: env.record.id, status: 'pending-revalidation', reason: 'host-version-mismatch', hostDigest: staleDigest, activatedAt: null }],
      web: [{ id: env.record.id, status: 'pending-revalidation', reason: 'host-version-mismatch', hostDigest: staleDigest, activatedAt: null }],
    },
  });

  const result = await review(env);
  assert.equal(result.status, 'restart-required');
  const [record] = result.records;
  assert.equal(record.hostCompatible, true, 'the record itself matches the review host');
  assert.equal(record.status, 'restart-required');
  assert.equal(record.action, REVIEW_ACTIONS.RESTART);
  assert.deepEqual(result.nextActions.map((action) => action.action), [REVIEW_ACTIONS.RESTART]);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'restart-consumer');
});

test('value assessment stays honest when no usage projection is supplied', async (t) => {
  const env = await fixture(t, 'value-unknown');
  await writeConsumers(env);
  const result = await review(env);
  const [record] = result.records;
  assert.equal(record.value.tier, 'usage-unknown');
  assert.equal(record.value.installed, true);
  assert.equal(record.value.invoked, null);
  assert.equal(record.value.workflowInvocations, null);
  assert.equal(record.value.experimentBenefit, true, 'the publication record still proves an experiment benefit');
  assert.equal(record.value.productionBenefit, false);
  assert.equal(result.retirementCandidates.length, 0, 'missing usage data is never a retirement reason');
  assert.equal(result.valueSummary.unknown, 1);
  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.stable.valueSummary.unknown, 1);
  assert.equal(composed.stable.retirementCandidates, 0);
});

test('a self-contained plugin with no workflow use becomes a reversible, owner-only retirement candidate', async (t) => {
  const env = await fixture(t, 'value-retire');
  await writeConsumers(env);
  const usage = {
    source: 'session-evidence',
    capturedAt: '2026-11-18T00:00:00.000Z',
    records: {
      [RECORD_ID]: {
        workflowInvocations: 0,
        verificationInvocations: 1,
        capabilityAssessment: 'self-contained',
      },
    },
  };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  assert.equal(record.value.invoked, false);
  assert.equal(record.value.workflowInvocations, 0);
  assert.equal(record.value.verificationInvocations, 1);
  assert.equal(record.value.tier, 'experiment-benefit');
  assert.equal(result.valueSummary.experimentBenefit, 1);
  assert.equal(result.retirementCandidates.length, 1);
  const [candidate] = result.retirementCandidates;
  assert.equal(candidate.recordId, RECORD_ID);
  assert.equal(candidate.requiresOwnerAuthorization, true);
  assert.equal(candidate.reversible, true);
  assert.deepEqual(candidate.profiles, ['acp', 'web']);
  assert.ok(candidate.commands.every((line) => line.includes('disable') && line.includes(RECORD_ID)));
  assert.ok(candidate.commands.every((line) => line.includes('--plugin ' + JSON.stringify(RECORD_ID))));
  assert.ok(candidate.commands.every((line) => !line.includes('--id ')), 'the CLI accepts --plugin, not --id');
  assert.match(candidate.reasons.join(' '), /self-contained/);
  assert.equal(record.retirement.candidate, true);
  // Verification traffic must not be counted as workflow usage.
  assert.notEqual(record.value.invoked, true);
  // The verdict must reach the ordered decision, not just sit in a side table.
  const retirementAction = result.nextActions.find((row) => row.action === 'review-retirement');
  assert.ok(retirementAction, 'an unused self-contained plugin is a next action');
  assert.equal(retirementAction.recordId, RECORD_ID);
  assert.equal(retirementAction.requiresOwnerAuthorization, true);
  assert.equal(retirementAction.reversible, true);
  assert.equal(retirementAction.evidence.workflowInvocations, 0);
  assert.ok(retirementAction.commands.every((line) => line.startsWith('node ')));
  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'review-retirement');
  assert.equal(composed.primary, 'review-retirement');
  assert.equal(composed.hasBlockingStableIssue, false, 'retirement is not a blocking repair');
  assert.equal(composed.stable.retirementCandidates, 1);
});

test('an incomplete or stale projection cannot produce a retirement recommendation', async (t) => {
  const env = await fixture(t, 'value-untrusted-zero');
  await writeConsumers(env);
  const row = { workflowInvocations: 0, verificationInvocations: 0, capabilityAssessment: 'self-contained' };
  for (const flags of [{ complete: false }, { stale: true }, { complete: false, stale: true }]) {
    const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST,
      usage: { source: 'session-evidence', capturedAt: '2026-11-20T00:00:00.000Z', ...flags, records: { [RECORD_ID]: row } } });
    assert.equal(result.records[0].value.invoked, null, JSON.stringify(flags));
    assert.equal(result.records[0].value.tier, 'usage-unknown');
    assert.equal(result.retirementCandidates.length, 0, JSON.stringify(flags));
    assert.equal(result.nextActions.some((action) => action.action === 'review-retirement'), false);
    assert.equal(result.usageEvidence.complete, flags.complete !== false);
    assert.equal(result.usageEvidence.stale, flags.stale === true);
  }
});

test('an unattributable call keeps "zero workflow usage" unknown', async (t) => {
  const env = await fixture(t, 'value-unattributed');
  await writeConsumers(env);
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST,
    usage: { source: 'session-evidence', capturedAt: '2026-11-20T00:00:00.000Z', complete: true, records: { [RECORD_ID]: {
      workflowInvocations: 0,
      verificationInvocations: 0,
      unattributedInvocations: 1,
      capabilityAssessment: 'self-contained',
    } } } });
  assert.equal(result.records[0].value.invoked, null);
  assert.equal(result.records[0].value.unattributedInvocations, 1);
  assert.match(result.records[0].value.reasons.join(' '), /could not be attributed/);
  assert.equal(result.retirementCandidates.length, 0);
});

test('workflow use or evidenced production benefit blocks a retirement recommendation', async (t) => {
  const env = await fixture(t, 'value-keep');
  await writeConsumers(env);
  const base = { source: 'session-evidence', records: { [RECORD_ID]: { verificationInvocations: 1, capabilityAssessment: 'self-contained' } } };
  const inUse = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST,
    usage: { ...base, records: { [RECORD_ID]: { ...base.records[RECORD_ID], workflowInvocations: 5 } } } });
  assert.equal(inUse.records[0].value.invoked, true);
  assert.equal(inUse.records[0].value.workflowInvocations, 5);
  assert.equal(inUse.retirementCandidates.length, 0);
  assert.equal(inUse.valueSummary.inUse, 1, 'a used plugin is reported as in-use even though a benefit decision also exists');
  const proven = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST,
    usage: { ...base, records: { [RECORD_ID]: { ...base.records[RECORD_ID], productionBenefit: { evidenced: true, summary: 'measured in daily sessions' } } } } });
  assert.equal(proven.records[0].value.tier, 'production-benefit');
  assert.equal(proven.records[0].value.productionBenefit, true);
  assert.equal(proven.retirementCandidates.length, 0);
  assert.equal(proven.valueSummary.productionBenefit, 1);
});

test('a missing or null workflow invocation count stays unknown and blocks retirement', async (t) => {
  const env = await fixture(t, 'value-missing-count');
  await writeConsumers(env);
  for (const row of [
    { capabilityAssessment: 'self-contained' },
    { workflowInvocations: null, capabilityAssessment: 'self-contained' },
    { workflowInvocations: 'not-a-count', capabilityAssessment: 'self-contained' },
  ]) {
    const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST,
      usage: { source: 'session-evidence', records: { [RECORD_ID]: row } } });
    const [record] = result.records;
    assert.equal(record.value.invoked, null);
    assert.equal(record.value.workflowInvocations, null);
    assert.equal(record.value.tier, 'usage-unknown');
    assert.equal(result.retirementCandidates.length, 0, JSON.stringify(row));
    assert.match(record.value.reasons.join(' '), /not usable/);
  }
});

test('a truncated stable review cannot compose a complete no-action result', () => {
  const composed = composeSelfEvolutionReview({
    stable: { status: 'active', truncated: true, nextActions: [], nextActionsDropped: 0, summary: { total: 50 } },
    experience: null,
    versions: CURRENT_HOST,
  });
  assert.equal(composed.kind, 'no-action');
  assert.equal(composed.incomplete, true);
});

test('withheld discovery evidence cannot compose a complete review', () => {
  const composed = composeSelfEvolutionReview({
    stable: { status: 'active', nextActions: [], nextActionsDropped: 0, summary: { total: 0 } },
    experience: { available: true, candidates: [], sources: { truncated: true } },
    versions: CURRENT_HOST,
  });
  assert.equal(composed.incomplete, true);
});

// ---------------------------------------------------------------------------
// Benefit provenance: the promotion decision alone does not say whether a
// workflow was ever compared. The durable observation does.
// ---------------------------------------------------------------------------

async function writeEvidence(env, observation) {
  await writeEvidenceFile(env.paths.dataRoot, env.record.experimentId, observation);
}

test('a capability self-test is not reported as an experiment benefit', async (t) => {
  const env = await fixture(t, 'provenance-self-test');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    probeDerived: true,
    probe: { comparison: { benefit: true, benefitKind: 'capability-self-test', workflowBenefit: false } },
    observationWindow: 'probe:complete-line',
    benefitEvidence: 'the target tool was absent before the trial and every sample matched',
  });
  const usage = { source: 'session-evidence', records: { [RECORD_ID]: {
    workflowInvocations: 0, verificationInvocations: 0, capabilityAssessment: 'self-contained',
  } } };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  assert.equal(record.value.benefitProvenance, 'capability-self-test');
  assert.equal(record.value.experimentBenefit, false, 'a self-test cannot satisfy the experiment-benefit rung');
  assert.equal(record.value.tier, 'installed-only');
  assert.equal(result.valueSummary.installedOnly, 1);
  assert.equal(result.valueSummary.experimentBenefit, 0);
  assert.match(record.value.reasons.join(' '), /capability self-test/);
  assert.equal(result.retirementCandidates.length, 1, 'an unused, self-tested, self-contained capability is a reversible candidate');
  assert.equal(result.retirementCandidates[0].evidence.benefitProvenance, 'capability-self-test');
});

test('a paired workflow comparison stays an experiment benefit', async (t) => {
  const env = await fixture(t, 'provenance-paired');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    probeDerived: true,
    probe: { comparison: { benefit: true, benefitKind: 'workflow', workflowBenefit: true, workload: { id: 'complete-source-line' } } },
    observationWindow: 'probe:complete-source-line',
  });
  const usage = { source: 'session-evidence', records: { [RECORD_ID]: {
    workflowInvocations: 0, verificationInvocations: 0, capabilityAssessment: 'self-contained',
  } } };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  assert.equal(record.value.benefitProvenance, 'paired-workflow');
  assert.equal(record.value.benefitBasis, 'complete-source-line');
  assert.equal(record.value.experimentBenefit, true);
  assert.equal(record.value.tier, 'experiment-benefit');
});

test('a context-policy capability reports its paired workflow benefit instead of usage-unknown', async (t) => {
  const env = await fixture(t, 'provenance-no-tool-surface');
  await writeConsumers(env);
  // The shape `recordTaskBenefit` writes: a real paired-session artifact whose
  // `adoption` counts sessions where the model *selected* the candidate (zero, by
  // construction for a context policy) and sessions where it ran.
  await writeEvidence(env, {
    solvesProblem: true,
    observationWindow: 'task:read-long-config-line',
    taskBenefit: {
      schemaVersion: 1,
      kind: 'paired-real-session',
      complete: true,
      improvement: 'context-policy',
      mechanismRan: true,
      benefit: true,
      adoption: { sessionsUsingCandidate: 0, sessionsExercised: 3 },
    },
  });
  const usage = { source: 'session-evidence', complete: true, recordsComplete: true, records: { [RECORD_ID]: {
    workflowInvocations: null, verificationInvocations: null, unattributedInvocations: null,
    measurement: 'no-tool-surface', capabilityAssessment: 'unknown',
  } } };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  assert.equal(record.value.benefitProvenance, 'paired-workflow');
  assert.equal(record.value.experimentBenefit, true);
  assert.equal(record.value.measurement, 'no-tool-surface');
  assert.equal(record.value.invoked, null, 'a count that does not apply is not a measured zero');
  assert.equal(record.value.tier, 'experiment-benefit', 'a proven workflow benefit is not hidden behind an inapplicable count');
  assert.equal(result.valueSummary.experimentBenefit, 1);
  assert.equal(result.valueSummary.unknown, 0);
  assert.equal(result.retirementCandidates.length, 0);
  const reasons = record.value.reasons.join(' ');
  assert.match(reasons, /registers no tool/);
  assert.match(reasons, /mechanism ran in 3 session\(s\), with the model selecting it in 0 session\(s\)/);
});

test('a no-tool-surface capability without paired evidence is unknown, never a retirement candidate', async (t) => {
  const env = await fixture(t, 'provenance-no-tool-surface-unproven');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    probeDerived: false,
    observationWindow: 'a mounted context policy',
    benefitEvidence: 'the candidate changed every read result in the trial',
  });
  const usage = { source: 'session-evidence', complete: true, recordsComplete: true, records: { [RECORD_ID]: {
    workflowInvocations: null, verificationInvocations: null, unattributedInvocations: null,
    measurement: 'no-tool-surface', capabilityAssessment: 'self-contained',
  } } };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  assert.equal(record.value.tier, 'installed-only');
  assert.equal(record.value.invoked, null);
  assert.equal(result.retirementCandidates.length, 0, 'an inapplicable count never unlocks retirement');
  assert.match(record.value.reasons.join(' '), /mounted but its effect is unproven/);
});

test('no persisted count can turn a no-tool-surface capability into an unused one', async (t) => {
  const env = await fixture(t, 'provenance-no-tool-surface-counts');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    probeDerived: false,
    observationWindow: 'a mounted context policy',
    benefitEvidence: 'the candidate changed every read result in the trial',
  });
  // A projection can pair the marker with a numeric count: a sidecar written
  // before the marker existed, a hand-edited file, or a writer regression. The
  // count does not apply to a capability with no call surface, so none of these
  // shapes may be read as a measured zero.
  const shapes = {
    'trusted zero': { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 0 },
    'zero with unattributed calls': { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 3 },
    'zero with verification calls': { workflowInvocations: 0, verificationInvocations: 2, unattributedInvocations: 0 },
    'positive count': { workflowInvocations: 4, verificationInvocations: 0, unattributedInvocations: 0 },
  };
  for (const [shape, counts] of Object.entries(shapes)) {
    const usage = { source: 'session-evidence', complete: true, recordsComplete: true, records: { [RECORD_ID]: {
      ...counts, measurement: 'no-tool-surface', capabilityAssessment: 'self-contained',
    } } };
    const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
    const [record] = result.records;
    assert.equal(record.value.measurement, 'no-tool-surface', shape);
    assert.equal(record.value.invoked, null, shape + ': a count that does not apply is never a measured zero');
    assert.equal(record.value.tier, 'installed-only', shape);
    assert.equal(result.retirementCandidates.length, 0, shape + ': an inapplicable count never unlocks retirement');
    assert.equal(record.retirement, undefined, shape);
    assert.match(record.value.reasons.join(' '), /registers no tool/, shape);
  }
});

test('no persisted count hides a no-tool-surface capability\'s paired workflow benefit', async (t) => {
  const env = await fixture(t, 'provenance-no-tool-surface-counts-paired');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    observationWindow: 'task:read-long-config-line',
    taskBenefit: {
      schemaVersion: 1,
      kind: 'paired-real-session',
      complete: true,
      improvement: 'context-policy',
      mechanismRan: true,
      benefit: true,
      adoption: { sessionsUsingCandidate: 0, sessionsExercised: 3 },
    },
  });
  const usage = { source: 'session-evidence', complete: true, recordsComplete: true, records: { [RECORD_ID]: {
    workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 0,
    measurement: 'no-tool-surface', capabilityAssessment: 'self-contained',
  } } };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  assert.equal(record.value.invoked, null);
  assert.equal(record.value.experimentBenefit, true);
  assert.equal(record.value.tier, 'experiment-benefit');
  assert.equal(result.valueSummary.experimentBenefit, 1);
  assert.equal(result.valueSummary.installedOnly, 0);
  assert.equal(result.retirementCandidates.length, 0);
  assert.match(record.value.reasons.join(' '), /mechanism ran in 3 session\(s\), with the model selecting it in 0 session\(s\)/);
});

test('the pre-comparison probe shape is classified by its baseline failure codes', async (t) => {
  const env = await fixture(t, 'provenance-legacy-probe');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    probe: {
      scenarioId: 'readonly-git-file-HEAD-package',
      comparison: {
        benefit: true,
        before: { executions: 2, successes: 0, perStep: [{ index: 0, step: 'readonly_git_file', role: 'target', codes: ['E_EVOLUTION_PROBE_CAPABILITY_ABSENT'] }] },
        after: { executions: 2, successes: 2, perStep: [{ index: 0, step: 'readonly_git_file', role: 'target', codes: [] }] },
      },
    },
    observationWindow: 'probe:readonly-git-file-HEAD-package',
    benefitEvidence: 'probe readonly-git-file-HEAD-package: candidate 2/2 vs baseline 0/2',
  });
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST });
  const [record] = result.records;
  assert.equal(record.value.benefitProvenance, 'capability-self-test', 'the baseline only recorded that the tool was absent');
  assert.equal(record.value.experimentBenefit, false);
  // No usage row was supplied: the tier must stay unknown rather than assume 0.
  assert.equal(record.value.tier, 'usage-unknown');
  assert.equal(result.retirementCandidates.length, 0);
});

test('a pre-comparison probe whose baseline ran and failed is a tool-level benefit, not a workflow', async (t) => {
  const env = await fixture(t, 'provenance-legacy-workflow');
  await writeConsumers(env);
  await writeEvidence(env, {
    solvesProblem: true,
    probe: {
      scenarioId: 'read-complete-line',
      comparison: {
        benefit: true,
        before: { executions: 3, successes: 1, perStep: [{ index: 0, step: 'read', role: 'target', codes: ['E_EVOLUTION_PROBE_INCORRECT'] }] },
        after: { executions: 3, successes: 3, perStep: [{ index: 0, step: 'read', role: 'target', codes: [] }] },
      },
    },
    observationWindow: 'probe:read-complete-line',
  });
  const usage = { source: 'session-evidence', records: { [RECORD_ID]: {
    workflowInvocations: 0, verificationInvocations: 0, capabilityAssessment: 'self-contained',
  } } };
  const result = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = result.records;
  // The model's surrounding execution path is absent from a plain probe pair,
  // so the durable evidence cannot claim a workflow benefit.
  assert.equal(record.value.benefitProvenance, 'unproven');
  assert.equal(record.value.experimentBenefit, false);
  assert.equal(record.value.tier, 'installed-only');
});

test('a missing promotion sidecar is unknown, never an experiment benefit', async (t) => {
  const env = await fixture(t, 'provenance-missing');
  await writeConsumers(env);
  await fs.rm(path.join(env.paths.dataRoot, 'archive', 'experiments', `${env.record.experimentId}.evidence.json`));
  const withoutUsage = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST });
  const [unknown] = withoutUsage.records;
  assert.equal(unknown.value.benefitProvenance, 'unknown');
  assert.equal(unknown.value.experimentBenefit, false, 'the recorded decision alone proves nothing');
  assert.equal(unknown.value.tier, 'usage-unknown');
  assert.doesNotMatch(unknown.value.reasons.join(' '), /paired workflow comparison is recorded/,
    'the review must not claim a comparison it could not read');

  const usage = { source: 'session-evidence', records: { [RECORD_ID]: {
    workflowInvocations: 0, verificationInvocations: 0, capabilityAssessment: 'self-contained',
  } } };
  const withUsage = await readPublishedPluginReview({ paths: env.paths, host: CURRENT_HOST, usage });
  const [record] = withUsage.records;
  assert.equal(record.value.tier, 'installed-only');
  assert.equal(record.value.experimentBenefit, false);
  assert.equal(withUsage.valueSummary.experimentBenefit, 0);
  assert.equal(withUsage.retirementCandidates.length, 1);
  assert.match(withUsage.retirementCandidates[0].reasons.join(' '), /unknown/);
});

// 2026-11-24 reliability round: the same consumer-host mismatch behind a stale
// `failed` row must not be reported as restart-required. Restarting a consumer
// that still runs another host can never mount the record.
test('a stale failure row on another host asks for revalidation, not a restart', async (t) => {
  const env = await fixture(t, 'consumer-host-mismatch-failed');
  const staleDigest = hostDigest(PREVIOUS_HOST);
  await writeConsumers(env, {
    host: PREVIOUS_HOST,
    rows: {
      acp: [{ id: env.record.id, status: 'failed', reason: 'plugin-apply-failed', hostDigest: staleDigest, activatedAt: null }],
      web: [{ id: env.record.id, status: 'failed', reason: 'plugin-apply-failed', hostDigest: staleDigest, activatedAt: null }],
    },
  });

  const result = await review(env);
  const [record] = result.records;
  assert.equal(record.status, 'pending-revalidation', JSON.stringify(record.profiles));
  assert.equal(record.action, REVIEW_ACTIONS.REVALIDATE);
  assert.equal(result.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART), false);
  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'revalidate');
});

test('a compatible consumer patch still reports a real apply failure, not a restart loop', async (t) => {
  const env = await fixture(t, 'consumer-compatible-patch');
  const consumerHost = { ...CURRENT_HOST, cordis: '4.1.1' };
  await writeConsumers(env, {
    host: consumerHost,
    rows: {
      acp: [{ id: env.record.id, status: 'failed', reason: 'plugin-apply-failed', hostDigest: hostDigest(consumerHost), activatedAt: null }],
      web: [{ id: env.record.id, status: 'active', reason: null, hostDigest: hostDigest(CURRENT_HOST), activatedAt: null }],
    },
  });
  const result = await review(env);
  const [record] = result.records;
  assert.equal(record.status, 'incompatible');
  assert.equal(record.action, REVIEW_ACTIONS.REPAIR);
  assert.equal(result.nextActions.some((row) => row.action === REVIEW_ACTIONS.RESTART), false);
});

test('a revoked record still mounted by a consumer asks for a restart', async (t) => {
  const env = await fixture(t, 'disabled-still-mounted');
  await writeConsumers(env); // default rows are active
  for (const profile of PROFILES) {
    await setDisabledForProfile(env.paths, { pluginId: RECORD_ID, profile, disabled: true, reason: 'operator test' });
  }
  const result = await review(env);
  assert.equal(result.status, 'restart-required');
  assert.equal(result.nextActions.length, 1);
  assert.equal(result.nextActions[0].action, REVIEW_ACTIONS.RESTART);
  assert.deepEqual(result.records[0].profiles.map((row) => row.status), ['restart-required', 'restart-required']);
  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'restart-consumer');
});

// One record can need a source repair for one profile while another profile
// only needs a restart after an adopted revalidation. The aggregate action is
// the repair, but the per-profile restart must not disappear with it.
test('a mixed repair and stale-revalidation record keeps a profile-named restart action', async (t) => {
  const env = await fixture(t, 'consumer-host-mismatch');
  await writeConsumers(env, {
    host: CURRENT_HOST,
    rows: {
      acp: [{ id: env.record.id, status: 'failed', reason: 'plugin-apply-failed', hostDigest: hostDigest(CURRENT_HOST), activatedAt: null }],
      web: [{ id: env.record.id, status: 'pending-revalidation', reason: 'host-version-mismatch',
        hostDigest: hostDigest(PREVIOUS_HOST), activatedAt: null }],
    },
  });
  const result = await review(env);
  assert.equal(result.status, 'incompatible');
  const actions = result.nextActions.map((action) => action.action);
  assert.ok(actions.includes(REVIEW_ACTIONS.REPAIR), `expected a repair action, got ${JSON.stringify(actions)}`);
  assert.ok(actions.includes(REVIEW_ACTIONS.RESTART), `the stale profile still needs a restart, got ${JSON.stringify(actions)}`);
  const restart = result.nextActions.find((action) => action.action === REVIEW_ACTIONS.RESTART);
  assert.deepEqual(restart.profiles, ['web']);
});
