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
  const index = await readSharedIndex(paths);
  assert.equal(index.status, 'ok');
  return { root, paths, pluginDir, modulePath, source, durable, experiment, record, index };
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
  await writeConsumers(env);
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

test('a record disabled for one profile stays active where it is still enabled', async (t) => {
  const env = await fixture(t, 'partial-disabled');
  await writeConsumers(env);
  const outcome = await setDisabledForProfile(env.paths, { pluginId: RECORD_ID, profile: 'acp', disabled: true, reason: 'operator test' });
  assert.equal(outcome.ok, true);

  const result = await review(env);
  assert.equal(result.status, 'active');
  assert.equal(result.summary.active, 1);
  assert.deepEqual(result.nextActions, []);

  const [record] = result.records;
  assert.equal(record.status, 'active');
  assert.equal(record.action, null);
  assert.deepEqual(record.profiles.map((row) => row.status).sort(), ['active', 'disabled']);

  const composed = composeSelfEvolutionReview({ stable: result, experience: null, versions: CURRENT_HOST });
  assert.equal(composed.kind, 'no-action');
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
