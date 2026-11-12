/**
 * Read-only unified review for one explicit self-evolution request.
 *
 * The owner asks for self-evolution in natural language; before any proposal is
 * allowed this module answers two questions from durable facts, without a model,
 * without a timer and without writing anything:
 *
 *   1. Are previously published stable plugins still usable on this host? The
 *      publication index, the verified source bytes, the per-profile consumer
 *      activation records, the operator revocations and the live host identity
 *      are read through `promoted-sharing.js` (the same contract the consumer
 *      and the publisher already share). A record is classified into a closed
 *      status and gets the one next action that is appropriate for it.
 *   2. Is there an evidence-ranked experience target worth a new experiment?
 *      The unified shared experience store is read with the existing bounded
 *      `discover()` window and ranked by the existing pure planner
 *      (`experience-plan.js`). This module does not implement a second planner
 *      or a second experience store.
 *
 * The composition step then orders the actions: a stable-plugin problem that
 * already blocks real use is handled before a new opportunity, and a host-only
 * mismatch is revalidated instead of being turned into a source change. Nothing
 * here starts a Trial, promotes, reverts, mutates the index, writes a task or
 * approves a promotion. The Desktop kernel remains the only execution and
 * promotion authority; the ACP side may call the same review function read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHARED_CONSUMER_PROFILES,
  captureHostFacts,
  consumerNeedsRestart,
  hostCompatible,
  hostDigest,
  isDisabledForProfile,
  readConsumerState,
  readDisableState,
  readPromotedPlugin,
  readSharedIndex,
  sharedFailure,
} from './promoted-sharing.js';
import { EXPERIENCE_PLAN_LIMITS, planEvolutionCandidates } from './experience-plan.js';
import { detectHostIdentity } from './runtime-versions.js';

export const SELF_EVOLUTION_REVIEW_LIMITS = Object.freeze({
  maxRecords: 50,
  maxReasons: 6,
  maxText: 240,
  maxActions: 12,
  maxInvalidRecords: 10,
  maxCandidates: EXPERIENCE_PLAN_LIMITS.maxCandidates,
});

/** The closed next-action vocabulary the review may report. */
export const REVIEW_ACTIONS = Object.freeze({
  NONE: 'none',
  REVALIDATE: 'revalidate',
  REPAIR: 'repair-stable',
  RESTART: 'restart-consumer',
  VERIFY_HOST: 'verify-host',
  OPERATOR: 'operator-action',
  EXPERIENCE: 'experience-candidate',
});

/** A stable-plugin status is the observed fact; the action is the response. */
const RECORD_STATUS = Object.freeze({
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  PENDING_REVALIDATION: 'pending-revalidation',
  INCOMPATIBLE: 'incompatible',
  RESTART_REQUIRED: 'restart-required',
  HOST_UNAVAILABLE: 'host-unavailable',
  VERIFY_HOST: 'verify-host',
  INVALID: 'invalid',
  SOURCE_UNUSABLE: 'source-unusable',
  BLOCKED: 'blocked',
});

const BLOCKING_ACTIONS = new Set([REVIEW_ACTIONS.VERIFY_HOST, REVIEW_ACTIONS.OPERATOR]);
const STABLE_PRIORITY = Object.freeze({
  [REVIEW_ACTIONS.OPERATOR]: 0,
  [REVIEW_ACTIONS.VERIFY_HOST]: 1,
  [REVIEW_ACTIONS.REVALIDATE]: 2,
  [REVIEW_ACTIONS.REPAIR]: 3,
  [REVIEW_ACTIONS.RESTART]: 4,
  [REVIEW_ACTIONS.NONE]: 9,
  [REVIEW_ACTIONS.EXPERIENCE]: 10,
});

function boundedText(value, limit = SELF_EVOLUTION_REVIEW_LIMITS.maxText) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…';
}

function boundedStrings(values, limit = SELF_EVOLUTION_REVIEW_LIMITS.maxReasons) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = boundedText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function failureProjection(error, reason) {
  const detail = sharedFailure(error, reason);
  return {
    reason: boundedText(detail.reason, 80) || 'review-error',
    errorCode: detail.errorCode,
    errorName: detail.errorName,
    errorDigest: detail.errorDigest,
  };
}

/** The evolution package's own version for the conclusion applicability triple. */
export function evolutionPackageVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return typeof manifest?.version === 'string' && manifest.version.trim() !== '' ? manifest.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Capture the live host identity through the official package service.
 *
 * This is the same `PluginPackages.packageOf` reader the consumer and the
 * Desktop publisher use; a host that does not expose it records null, which
 * keeps the affected record unverified instead of assuming compatibility.
 */
export function captureReviewHost(ctx, profile = null) {
  let packageOf;
  try {
    const packages = typeof ctx?.get === 'function' ? ctx.get('pluginPackages') : null;
    if (typeof packages?.packageOf === 'function') packageOf = (name, baseUrl) => packages.packageOf(name, baseUrl);
  } catch {
    packageOf = undefined;
  }
  let resolvedProfile = profile;
  if (!resolvedProfile) {
    try { resolvedProfile = typeof ctx?.get === 'function' ? ctx.get('profileContext')?.name ?? null : null; } catch { resolvedProfile = null; }
  }
  const host = captureHostFacts({ packageOf, profile: resolvedProfile, baseUrl: typeof ctx?.baseUrl === 'string' ? ctx.baseUrl : undefined });
  // The ACP profile can boot without the official package service that
  // captureHostFacts uses. Fall back to the exact process/package identity
  // (same rules as the Evolution applicability reader) so a real host is
  // still classified instead of every record becoming unverified.
  const missing = (value) => typeof value !== 'string' || value.trim() === '';
  if (!missing(host.dsh) && !missing(host.cordis) && !missing(host.include)) return host;
  let detected = null;
  try { detected = detectHostIdentity(); } catch { detected = null; }
  return {
    ...host,
    dsh: missing(host.dsh) ? detected?.dsh ?? null : host.dsh,
    cordis: missing(host.cordis) ? detected?.cordis ?? null : host.cordis,
    include: missing(host.include) ? detected?.include ?? null : host.include,
    node: missing(host.node) ? detected?.node ?? process.version : host.node,
  };
}

/** The applicability triple used by the experience planner, with explicit unknowns. */
export function reviewApplicability(versions = {}) {
  const read = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown');
  return {
    dsh: read(versions.dsh),
    cordis: read(versions.cordis),
    evolution: read(versions.evolution),
  };
}

export function reviewApplicabilityKnown(applicability = {}) {
  return [applicability.dsh, applicability.cordis, applicability.evolution]
    .every((value) => typeof value === 'string' && value !== '' && value.toLowerCase() !== 'unknown');
}

function sharedPathsFor(paths = {}) {
  const requested = paths.dataRoot || paths.presetDir;
  if (typeof requested !== 'string' || requested.trim() === '') throw new Error('Self-evolution review requires a data root');
  const dataRoot = path.resolve(requested);
  return {
    dataRoot,
    pluginRoot: typeof paths.pluginRoot === 'string' ? path.resolve(paths.pluginRoot) : path.join(dataRoot, 'promoted'),
  };
}

function recordAction(status) {
  switch (status) {
    case RECORD_STATUS.PENDING_REVALIDATION: return REVIEW_ACTIONS.REVALIDATE;
    case RECORD_STATUS.INCOMPATIBLE: return REVIEW_ACTIONS.REPAIR;
    case RECORD_STATUS.RESTART_REQUIRED:
    case RECORD_STATUS.HOST_UNAVAILABLE: return REVIEW_ACTIONS.RESTART;
    case RECORD_STATUS.VERIFY_HOST: return REVIEW_ACTIONS.VERIFY_HOST;
    case RECORD_STATUS.INVALID:
    case RECORD_STATUS.SOURCE_UNUSABLE:
    case RECORD_STATUS.BLOCKED: return REVIEW_ACTIONS.OPERATOR;
    default: return null;
  }
}

function profileVerdict(row, { profile, hostDigest: currentDigest, restartPending, stateStatus, recordHost, consumerHost }) {
  if (stateStatus !== 'ok') return { profile, status: 'unverified', reason: 'consumer-state-' + stateStatus, current: false };
  if (row === null || row === undefined) return { profile, status: 'unverified', reason: 'no-activation-record', current: false };
  const status = typeof row.status === 'string' ? row.status : 'unknown';
  const reason = typeof row.reason === 'string' ? row.reason : null;
  const current = typeof row.hostDigest === 'string' && row.hostDigest === currentDigest;
  switch (status) {
    case 'active':
      return { profile, status: restartPending ? 'restart-required' : 'active', reason: restartPending ? 'index-changed-since-consumer-start' : null, current };
    case 'failed':
      if (reason === 'include-unavailable') return { profile, status: 'host-unavailable', reason, current };
      return current
        ? { profile, status: 'apply-failed', reason: reason || 'previous-failure', current }
        : { profile, status: 'stale-failure', reason: reason || 'previous-failure', current };
    case 'skipped-incompatible':
      return current
        ? { profile, status: 'incompatible', reason: reason || 'missing-host-capability', current }
        : { profile, status: 'stale-incompatible', reason: reason || 'missing-host-capability', current };
    case 'skipped-invalid':
      return { profile, status: 'invalid', reason: reason || 'record-invalid', current };
    case 'pending-revalidation': {
      // A restart only helps when the consumer's own host already satisfies the
      // record. When it does not, the mismatch that stopped this profile is
      // still real (the review host and that consumer run different versions),
      // so only a new revalidation generation can clear it; advising a restart
      // would loop without ever mounting the plugin.
      const restartHelps = hostCompatible(recordHost, consumerHost).ok === true;
      return { profile, status: restartHelps ? 'stale-revalidation' : 'pending-revalidation', reason: reason || 'host-version-mismatch', current };
    }
    case 'skipped-unapproved':
      // The caller iterates the record's current approvedProfiles, so this
      // profile is approved now and the row predates the approval: one restart
      // mounts it. Treating it as unapproved would report active/inactive with
      // no action and hide the needed restart.
      return { profile, status: 'restart-required', reason: reason || 'eligibility-changed-since-consumer-start', current };
    case 'disabled':
      // The caller already applied the current revocation table, so an
      // operator-disabled row here predates a restored eligibility and needs a
      // restart. "already-mounted" (the module URL is mounted by this profile
      // already) and "publisher-profile" are properties that survive a restart,
      // so they stay inactive instead of becoming a restart loop.
      if (reason === 'already-mounted' || reason === 'publisher-profile') {
        return { profile, status: 'disabled', reason, current };
      }
      return { profile, status: 'restart-required', reason: reason || 'eligibility-changed-since-consumer-start', current };
    case 'pending-restart':
      return { profile, status: 'restart-required', reason: reason || 'operator-reset', current };
    default:
      return { profile, status: 'unverified', reason: 'consumer-' + boundedText(status, 40), current };
  }
}

function aggregateRecordStatus(verdicts, approvedProfiles) {
  const withStatus = (name) => verdicts.filter((row) => row.status === name);
  if (withStatus('invalid').length > 0) return RECORD_STATUS.INVALID;
  if (withStatus('apply-failed').length > 0 || withStatus('incompatible').length > 0) return RECORD_STATUS.INCOMPATIBLE;
  if (withStatus('host-unavailable').length > 0) return RECORD_STATUS.HOST_UNAVAILABLE;
  // A profile that has not been revalidated on its own host cannot be fixed by
  // restarting it, so revalidation outranks the restart-required fallbacks.
  if (withStatus('pending-revalidation').length > 0) return RECORD_STATUS.PENDING_REVALIDATION;
  // Profiles the operator explicitly disabled (or that are not approved) are
  // not expected to activate; a record that is active everywhere else needs no
  // action. Requiring every approved profile here would turn a deliberate
  // revocation into a false restart/revalidation.
  const expected = verdicts.filter((row) => row.status !== 'disabled' && row.status !== 'unapproved');
  const active = withStatus('active');
  if (expected.length > 0 && active.length === expected.length) return RECORD_STATUS.ACTIVE;
  if (withStatus('restart-required').length > 0) return RECORD_STATUS.RESTART_REQUIRED;
  if (expected.length === 0) return RECORD_STATUS.INACTIVE;
  return RECORD_STATUS.RESTART_REQUIRED;
}

function revalidationInstruction(record, scriptPath, cause) {
  return {
    action: REVIEW_ACTIONS.REVALIDATE,
    recordId: record.id,
    why: 'The record was verified on DSH ' + boundedText(String(record.host?.dsh ?? 'unknown'), 80) + '; ' + cause + '; verify it on a real isolated host instead of assuming compatibility.',
    evidence: 'A real isolated-host cross-entry verification report for this exact plugin id and sourceSha256 on the current host.',
    command: 'node ' + JSON.stringify(scriptPath) + ' revalidate --evidence <evidence.json>',
    forbidden: ['edit or regenerate the promoted plugin source', 'weaken the recorded host identity'],
  };
}

function scriptPath() {
  try {
    const file = fileURLToPath(new URL('../scripts/shared-plugins.mjs', import.meta.url));
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * Priority order shared by the durable review and the composed decision.
 * `operator-action` and `verify-host` must never be dropped by the action cap
 * just because a lower-priority record appears earlier in the index.
 */
function actionPriority(action) {
  return STABLE_PRIORITY[action?.action] ?? 8;
}

export function orderStableActions(actions = []) {
  return [...(Array.isArray(actions) ? actions : [])].sort((left, right) => {
    const byPriority = actionPriority(left) - actionPriority(right);
    if (byPriority !== 0) return byPriority;
    const leftId = String(left?.recordId ?? '');
    const rightId = String(right?.recordId ?? '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}
/**
 * Read and classify every published stable plugin against one live host.
 *
 * The function never throws for an unreadable index, revocation table or
 * source: those are facts the review reports (with a closed reason), because a
 * self-evolution request must not fail merely because one durable record is
 * damaged. Only a missing data root is a caller error.
 */
export async function readPublishedPluginReview({ paths, host } = {}) {
  const shared = sharedPathsFor(paths);
  const summary = {
    total: 0, active: 0, pendingRevalidation: 0, incompatible: 0, restartRequired: 0,
    hostUnavailable: 0, inactive: 0, invalid: 0, sourceUnusable: 0, blocked: 0, verifyHost: 0,
  };
  const index = await readSharedIndex(shared);
  const disable = await readDisableState(shared);
  const consumers = {};
  for (const profile of SHARED_CONSUMER_PROFILES) {
    try {
      consumers[profile] = await readConsumerState(shared, profile);
    } catch (error) {
      consumers[profile] = { status: 'unreadable', state: null, error: failureProjection(error, 'consumer-state-unreadable') };
    }
  }
  const base = {
    kind: 'dsh-evolution-self-evolution-review',
    readOnly: true,
    indexStatus: index.status,
    indexUpdatedAt: index.updatedAt ?? null,
    disableStatus: disable.status,
    indexRecordCount: Array.isArray(index.records) ? index.records.length : 0,
    truncated: Boolean(Array.isArray(index.records) && index.records.length > SELF_EVOLUTION_REVIEW_LIMITS.maxRecords),
    host: host && typeof host === 'object' ? {
      profile: typeof host.profile === 'string' ? host.profile : null,
      dsh: typeof host.dsh === 'string' ? host.dsh : null,
      cordis: typeof host.cordis === 'string' ? host.cordis : null,
      include: typeof host.include === 'string' ? host.include : null,
      node: typeof host.node === 'string' ? host.node : null,
    } : null,
    records: [],
    invalidRecords: (Array.isArray(index.invalid) ? index.invalid : []).slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxInvalidRecords).map((row) => ({
      index: Number.isInteger(row?.index) ? row.index : null,
      id: typeof row?.id === 'string' ? boundedText(row.id, 120) : null,
      reason: boundedText(row?.reason, 80) || 'invalid-record',
    })),
    consumers: Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => {
      const state = consumers[profile];
      return [profile, {
        status: state.status,
        updatedAt: typeof state.state?.updatedAt === 'string' ? boundedText(state.state.updatedAt, 40) : null,
        observedIndexUpdatedAt: typeof state.state?.observedIndexUpdatedAt === 'string' ? boundedText(state.state.observedIndexUpdatedAt, 40) : null,
        needsRestart: Boolean(state.state) && consumerNeedsRestart(index.updatedAt, state.state),
        rows: (state.state?.plugins ?? []).slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxRecords).map((row) => ({
          id: typeof row.id === 'string' ? row.id : null,
          status: typeof row.status === 'string' ? row.status : null,
          reason: typeof row.reason === 'string' ? boundedText(row.reason, 80) : null,
          activatedAt: typeof row.activatedAt === 'string' ? row.activatedAt : null,
        })),
      }];
    })),
    summary,
    nextActions: [],
    nextActionsDropped: 0,
  };

  // A publication index can be structurally valid while one of its records
  // fails validation. Consumers reject that row as `skipped-invalid`; hiding it
  // would let the review claim `active/no-action` while a published plugin is
  // actually unusable. Count it and surface one bounded operator action per
  // damaged row (the list itself is capped by the output budget below).
  if (index.status === 'ok' && Array.isArray(index.invalid) && index.invalid.length > 0) {
    summary.invalid = index.invalid.length;
    for (const invalid of index.invalid) {
      base.nextActions.push({
        action: REVIEW_ACTIONS.OPERATOR,
        recordId: typeof invalid?.id === 'string' ? boundedText(invalid.id, 120) : null,
        why: 'a published record failed validation: ' + (boundedText(invalid?.reason, 80) || 'invalid-record'),
      });
    }
  }

  if (index.status === 'absent') {
    return { ...base, status: 'absent', reason: 'no published stable plugin' };
  }
  if (index.status === 'invalid' || index.status === 'unreadable') {
    return {
      ...base,
      status: 'blocked',
      reason: 'publication-index-unreadable',
      summary: { ...summary, blocked: 1 },
      nextActions: [{
        action: REVIEW_ACTIONS.OPERATOR,
        recordId: null,
        why: 'The shared publication index is ' + index.status + '; consumers refuse every record until it is restored or removed.',
      }],
    };
  }

  const currentDigest = host && typeof host === 'object' ? hostDigest(host) : null;
  const hostKnown = Boolean(host) && ['dsh', 'cordis', 'include', 'node']
    .every((key) => typeof host[key] === 'string' && host[key].trim() !== '');
  const resolvedScriptPath = scriptPath();
  const records = [];
  for (const record of index.records.slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxRecords)) {
    const reasons = [];
    let source = 'verified';
    if (typeof record.sourceSha256 !== 'string') {
      source = 'source-unusable';
      reasons.push('published record has no source digest');
    } else {
      try {
        const plugin = await readPromotedPlugin(shared, { pluginName: record.pluginName, moduleUrl: record.moduleUrl, entry: record.entry });
        if (plugin.sourceSha256 !== record.sourceSha256) { source = 'source-digest-mismatch'; reasons.push('plugin bytes differ from the published source digest'); }
        else if (plugin.manifestSha256 !== record.manifestSha256) { source = 'manifest-digest-mismatch'; reasons.push('plugin manifest differs from the published manifest digest'); }
      } catch (error) {
        source = 'source-unusable';
        reasons.push('plugin source is unusable: ' + failureProjection(error, 'source-unusable').reason);
      }
    }

    const hostVerdict = hostCompatible(record.host, host);
    let status;
    let action = null;
    const verdicts = [];
    const allDisabled = disable.status === 'ok'
      && record.approvedProfiles.length > 0
      && record.approvedProfiles.every((profile) => isDisabledForProfile(disable, record.id, profile));
    if (source !== 'verified') {
      status = RECORD_STATUS.SOURCE_UNUSABLE;
      action = REVIEW_ACTIONS.OPERATOR;
    } else if (allDisabled) {
      // An explicit operator revocation for every approved profile is not a
      // blocker: revalidating a plugin nothing is allowed to mount would only
      // create busywork and hide the authorization decision.
      status = RECORD_STATUS.INACTIVE;
      action = null;
      for (const profile of record.approvedProfiles) {
        verdicts.push({ profile, status: 'disabled', reason: 'operator-disabled', current: true });
      }
    } else if (!hostKnown) {
      status = RECORD_STATUS.VERIFY_HOST;
      action = REVIEW_ACTIONS.VERIFY_HOST;
      reasons.push('the live host identity is unavailable so compatibility cannot be proven');
    } else if (hostVerdict.ok === false) {
      status = RECORD_STATUS.PENDING_REVALIDATION;
      action = REVIEW_ACTIONS.REVALIDATE;
      reasons.push('recorded host does not match the live host (' + hostVerdict.reason + ')');
    } else if (disable.status === 'invalid' || disable.status === 'unreadable') {
      status = RECORD_STATUS.BLOCKED;
      action = REVIEW_ACTIONS.OPERATOR;
      reasons.push('the per-profile revocation table is ' + disable.status + '; consumers refuse every record');
    } else {
      for (const profile of record.approvedProfiles) {
        const state = consumers[profile] ?? { status: 'unreadable', state: null };
        if (isDisabledForProfile(disable, record.id, profile)) {
          verdicts.push({ profile, status: 'disabled', reason: 'operator-disabled', current: true });
          continue;
        }
        const row = state.status === 'ok'
          ? (state.state.plugins ?? []).find((entry) => entry.id === record.id) ?? null
          : null;
        verdicts.push(profileVerdict(row, {
          profile,
          hostDigest: currentDigest,
          restartPending: state.status === 'ok' && consumerNeedsRestart(index.updatedAt, state.state),
          stateStatus: state.status,
          recordHost: record.host,
          consumerHost: state.state?.host ?? null,
        }));
      }
      status = aggregateRecordStatus(verdicts, record.approvedProfiles);
      action = recordAction(status);
      for (const verdict of verdicts) {
        if (verdict.reason && verdict.status !== 'active' && verdict.status !== 'unapproved' && verdict.status !== 'disabled') {
          reasons.push(verdict.profile + ': ' + verdict.status + ' (' + verdict.reason + ')');
        }
      }
    }

    if (action === REVIEW_ACTIONS.REVALIDATE) {
      // Name the real cause. A record-level mismatch is about this host; a
      // per-profile pending row on an otherwise matching record means a
      // consumer last booted on another host, which a restart cannot fix by
      // itself. In that case the action must name the profile and the host its
      // evidence has to come from, instead of repeating "the current host".
      const mismatched = verdicts.filter((row) => row.status === 'pending-revalidation');
      const consumerHostFacts = (profile) => {
        const host = consumers[profile]?.state?.host;
        if (!host || typeof host !== 'object') return null;
        return {
          dsh: boundedText(host.dsh, 40) || null,
          cordis: boundedText(host.cordis, 40) || null,
          include: boundedText(host.include, 40) || null,
          node: boundedText(host.node, 40) || null,
        };
      };
      const splitHosts = hostVerdict.ok !== false && mismatched.length > 0;
      const cause = hostVerdict.ok === false
        ? 'the live host does not match (' + boundedText(String(hostVerdict.reason ?? 'host-mismatch'), 80) + ')'
        : splitHosts
          ? 'consumer ' + mismatched.map((row) => row.profile + (consumerHostFacts(row.profile)?.dsh ? ' runs DSH ' + consumerHostFacts(row.profile).dsh : '')).join(', ') + ' instead of the verified DSH ' + boundedText(String(record.host?.dsh ?? 'unknown'), 80)
          : 'a consumer host does not match';
      const instruction = revalidationInstruction(record, resolvedScriptPath, boundedText(cause, 220));
      if (splitHosts) {
        instruction.profiles = mismatched.map((row) => row.profile);
        instruction.consumerHosts = Object.fromEntries(mismatched.map((row) => [row.profile, consumerHostFacts(row.profile)]));
        instruction.prerequisite = 'A restart alone cannot clear this: align the named consumer with the verified host (upgrade or restart it). Only if it must keep a different DSH version, verify these exact bytes on that host; entries still on another version then report pending-revalidation.';
        instruction.evidence = 'A real isolated-host cross-entry verification report for this exact plugin id and sourceSha256 on the DSH version named by consumerHosts; adopting it makes entries still on another DSH version pending until they are aligned.';
      }
      if (resolvedScriptPath === null) delete instruction.command;
      base.nextActions.push(instruction);
    } else if (action && action !== REVIEW_ACTIONS.NONE) {
      base.nextActions.push({
        action,
        recordId: record.id,
        why: reasons[0] ?? 'stable plugin is ' + status,
        ...(status === RECORD_STATUS.INCOMPATIBLE ? { rootCauseHint: 'read the consumer failure reason and the recorded experience before proposing the smallest fix' } : {}),
      });
    }

    records.push({
      id: record.id,
      experimentId: record.experimentId,
      pluginName: record.pluginName,
      approvedProfiles: [...record.approvedProfiles],
      status,
      action,
      source,
      hostCompatible: hostVerdict.ok,
      hostReason: hostVerdict.reason,
      revalidationGenerations: Array.isArray(record.revalidation) ? record.revalidation.length : 0,
      publishedAt: typeof record.publishedAt === 'string' ? boundedText(record.publishedAt, 40) : null,
      host: record.host ? {
        dsh: record.host.dsh ?? null,
        cordis: record.host.cordis ?? null,
        include: record.host.include ?? null,
        node: record.host.node ?? null,
        verifiedAt: record.host.verifiedAt ?? null,
      } : null,
      profiles: verdicts.map((row) => ({ ...row, reason: typeof row.reason === 'string' ? boundedText(row.reason, 80) : row.reason })),
      reasons: boundedStrings(reasons),
    });
    summary.total += 1;
    const bucket = {
      [RECORD_STATUS.ACTIVE]: 'active',
      [RECORD_STATUS.INACTIVE]: 'inactive',
      [RECORD_STATUS.PENDING_REVALIDATION]: 'pendingRevalidation',
      [RECORD_STATUS.INCOMPATIBLE]: 'incompatible',
      [RECORD_STATUS.RESTART_REQUIRED]: 'restartRequired',
      [RECORD_STATUS.HOST_UNAVAILABLE]: 'hostUnavailable',
      [RECORD_STATUS.INVALID]: 'invalid',
      [RECORD_STATUS.SOURCE_UNUSABLE]: 'sourceUnusable',
      [RECORD_STATUS.BLOCKED]: 'blocked',
      [RECORD_STATUS.VERIFY_HOST]: 'verifyHost',
    }[status];
    if (bucket) summary[bucket] += 1;
  }

  return {
    ...base,
    status: summary.blocked > 0 || summary.sourceUnusable > 0 || summary.invalid > 0
      ? 'blocked'
      : summary.pendingRevalidation > 0
        ? 'pending-revalidation'
        : summary.incompatible > 0
          ? 'incompatible'
          : summary.restartRequired > 0
            ? 'restart-required'
            : summary.verifyHost > 0
              ? 'verify-host'
              : summary.total > 0 && summary.active === summary.total
                ? 'active'
                : 'inactive',
    records,
    ...(() => {
      const ordered = orderStableActions(base.nextActions);
      const nextActions = ordered.slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxActions);
      return { nextActions, nextActionsDropped: ordered.length - nextActions.length };
    })(),
    summary,
  };
}

/**
 * Read the bounded experience plan for a review.
 *
 * `store` is the existing unified shared experience store (`discover()`);
 * `failureMemory` stays the caller's projection of the local durable failure
 * memory. The ranking is the one existing pure planner, so ACP and Desktop
 * cannot disagree about which target has the strongest evidence.
 */
export function reviewExperience({
  store = null,
  failureMemory = [],
  versions = {},
  focus,
  minOccurrences,
  limit,
  now = Date.now(),
} = {}) {
  const applicability = reviewApplicability(versions);
  const errors = [];
  let knowledge = [];
  let truncated = false;
  if (store && typeof store.discover === 'function') {
    try {
      const discovered = store.discover({ window: EXPERIENCE_PLAN_LIMITS.maxConsidered });
      knowledge = Array.isArray(discovered?.records) ? discovered.records : [];
      truncated = discovered?.truncated === true;
    } catch (error) {
      errors.push(failureProjection(error, 'shared-experience-unreadable'));
    }
  } else {
    errors.push({ reason: 'shared-experience-store-unavailable', errorCode: 'E_EVOLUTION_PLAN_NO_SHARED_STORE' });
  }
  const requestedLimit = Number(limit);
  const maxCandidates = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(EXPERIENCE_PLAN_LIMITS.maxCandidates, Math.floor(requestedLimit))
    : SELF_EVOLUTION_REVIEW_LIMITS.maxCandidates;
  const requestedMinimum = Number(minOccurrences);
  const floor = Number.isFinite(requestedMinimum) && requestedMinimum > 0
    ? Math.max(EXPERIENCE_PLAN_LIMITS.minOccurrences, Math.floor(requestedMinimum))
    : EXPERIENCE_PLAN_LIMITS.minOccurrences;
  const normalizedFocus = boundedText(focus, 120).toLowerCase();
  let planned;
  try {
    planned = planEvolutionCandidates(
      { knowledge, failureMemory: Array.isArray(failureMemory) ? failureMemory : [], versions: applicability },
      { minOccurrences: floor, maxCandidates, focus: normalizedFocus, now },
    );
  } catch (error) {
    return {
      available: false,
      applicability,
      applicabilityVerified: reviewApplicabilityKnown(applicability),
      selected: null,
      candidates: [],
      none: { reason: 'plan-unavailable', considered: 0, detail: failureProjection(error, 'plan-unavailable').reason },
      rejected: [],
      sources: { shared: knowledge.length, failureMemory: 0, truncated },
      errors: [...errors, failureProjection(error, 'plan-unavailable')],
    };
  }
  return {
    available: errors.length === 0 || knowledge.length > 0,
    applicability,
    applicabilityVerified: reviewApplicabilityKnown(applicability),
    selected: planned.selected ?? null,
    candidates: planned.candidates ?? [],
    // An empty plan caused by an unreachable store is not the same fact as
    // "history has no failure signal"; report the store itself as the reason.
    none: planned.none && planned.none.reason === 'no-failure-signal' && knowledge.length === 0
      && errors.some((entry) => entry.reason === 'shared-experience-store-unavailable')
      ? { reason: 'store-unavailable', considered: 0, detail: 'the unified experience store is unavailable and local failure memory did not supply a candidate' }
      : planned.none ?? null,
    rejected: planned.rejected ?? [],
    sources: {
      shared: knowledge.length,
      failureMemory: Array.isArray(failureMemory) ? failureMemory.length : 0,
      truncated,
    },
    errors,
  };
}

/**
 * Compose the ordered review: blocking stable-plugin actions first, then the
 * cheapest compatible recovery, then new experience-backed work, and finally an
 * explicit no-action result. The returned document is lossless JSON and bounded.
 */
export function composeSelfEvolutionReview({ stable, experience = null, versions = {} } = {}) {
  const actions = [];
  const push = (action) => {
    if (!action || typeof action !== 'object') return;
    const key = String(action.action) + '\u0000' + String(action.recordId ?? '') + '\u0000' + String(action.problemKey ?? '') + '\u0000' + String(action.profile ?? '');
    if (actions.some((row) => row.key === key)) return;
    actions.push({ ...action, key });
  };
  for (const action of Array.isArray(stable?.nextActions) ? stable.nextActions : []) push(action);
  const stableUnavailable = !stable || stable.status === 'unavailable';
  if (stableUnavailable) {
    push({
      action: REVIEW_ACTIONS.OPERATOR,
      why: 'The stable-plugin review could not run; treat the audit as incomplete and read the error evidence before acting.',
    });
  }
  const blocking = actions.filter((action) => BLOCKING_ACTIONS.has(action.action) || action.action === REVIEW_ACTIONS.REVALIDATE || action.action === REVIEW_ACTIONS.REPAIR);
  const experienceAvailable = experience !== null && experience !== undefined && experience.available !== false;
  if (experience?.selected) {
    push({
      action: REVIEW_ACTIONS.EXPERIENCE,
      problemKey: experience.selected.problemKey,
      why: experience.selected.occurrences + ' recorded occurrence(s); expected: ' + boundedText(experience.selected.expectedImprovement, 160),
      requiresNewHypothesis: experience.selected.requiresNewHypothesis === true,
      ...(blocking.length > 0 ? { blockedBy: blocking.slice(0, 3).map((row) => row.recordId ?? row.problemKey ?? row.action) } : {}),
    });
  }
  actions.sort((left, right) => {
    const leftPriority = STABLE_PRIORITY[left.action] ?? 8;
    const rightPriority = STABLE_PRIORITY[right.action] ?? 8;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const leftId = String(left.recordId ?? left.problemKey ?? '');
    const rightId = String(right.recordId ?? right.problemKey ?? '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const boundedActions = actions.slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxActions).map(({ key, ...action }) => action);
  const primary = boundedActions[0]?.action ?? REVIEW_ACTIONS.NONE;
  return {
    kind: primary === REVIEW_ACTIONS.NONE ? 'no-action' : primary,
    primary,
    hasBlockingStableIssue: blocking.length > 0,
    nextActions: boundedActions,
    stable: stable ? {
      status: stable.status ?? 'unknown',
      summary: stable.summary ?? null,
      nextActions: Array.isArray(stable.nextActions) ? stable.nextActions.length : 0,
      nextActionsDropped: Number.isInteger(stable.nextActionsDropped) ? stable.nextActionsDropped : 0,
    } : null,
    experience: experience ? {
      available: experienceAvailable,
      selected: experience.selected
        ? {
          problemKey: experience.selected.problemKey,
          occurrences: experience.selected.occurrences,
          requiresNewHypothesis: experience.selected.requiresNewHypothesis === true,
          provenIneffective: Array.isArray(experience.selected.provenIneffective) ? experience.selected.provenIneffective.length : 0,
        }
        : null,
      none: experience.none ?? null,
      candidateCount: Array.isArray(experience.candidates) ? experience.candidates.length : 0,
      errors: Array.isArray(experience.errors) ? experience.errors.slice(0, 3) : [],
    } : null,
    versions: reviewApplicability(versions),
    applicabilityVerified: reviewApplicabilityKnown(reviewApplicability(versions)),
    incomplete: stableUnavailable || (experience !== null && experience !== undefined && experience.available === false)
      || (Number.isInteger(stable?.nextActionsDropped) && stable.nextActionsDropped > 0)
      || stable?.truncated === true,
    readOnly: true,
  };
}
