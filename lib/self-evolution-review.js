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
  completeHostFacts,
  consumerNeedsRestart,
  hostCompatible,
  hostDigest,
  hostFactsComplete,
  isDisabledForProfile,
  readConsumerState,
  readDisableState,
  readPromotedPlugin,
  readSharedIndex,
  sharedFailure,
} from './promoted-sharing.js';
import { EXPERIENCE_PLAN_LIMITS, planEvolutionCandidates } from './experience-plan.js';
import { USAGE_PROJECTION_COVERAGE } from './capability-usage.js';
import { detectHostIdentity } from './runtime-versions.js';

export const SELF_EVOLUTION_REVIEW_LIMITS = Object.freeze({
  maxRecords: 50,
  maxReasons: 6,
  maxText: 240,
  maxActions: 12,
  maxInvalidRecords: 10,
  maxTruncatedSampleIds: 5,
  maxCandidates: EXPERIENCE_PLAN_LIMITS.maxCandidates,
  maxBenefitEvidenceBytes: 2 * 1024 * 1024,
});

/** Benefit provenance is derived from the durable promotion evidence, not claimed. */
export const BENEFIT_PROVENANCE = Object.freeze({
  PAIRED_WORKFLOW: 'paired-workflow',
  CAPABILITY_SELF_TEST: 'capability-self-test',
  UNPROVEN: 'unproven',
  UNKNOWN: 'unknown',
});

/** The closed next-action vocabulary the review may report. */
export const REVIEW_ACTIONS = Object.freeze({
  NONE: 'none',
  REVALIDATE: 'revalidate',
  REPAIR: 'repair-stable',
  RESTART: 'restart-consumer',
  VERIFY_HOST: 'verify-host',
  OPERATOR: 'operator-action',
  RETIRE: 'review-retirement',
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
  // A retirement review is lower priority than every way a stable record can be
  // made to work again: never recommend removing something that is merely
  // unverified or restartable. It still outranks "no action" and a new
  // experiment, because an unused, self-contained result already occupies the
  // profile without serving a workflow.
  [REVIEW_ACTIONS.RETIRE]: 5,
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

/** The closed value tiers of a published plugin, from installation upward. */
const VALUE_TIER = Object.freeze({
  PRODUCTION_BENEFIT: 'production-benefit',
  EXPERIMENT_BENEFIT: 'experiment-benefit',
  IN_USE: 'in-use',
  INSTALLED_ONLY: 'installed-only',
  UNKNOWN: 'usage-unknown',
});

const VALUE_SUMMARY_KEY = Object.freeze({
  [VALUE_TIER.PRODUCTION_BENEFIT]: 'productionBenefit',
  [VALUE_TIER.EXPERIMENT_BENEFIT]: 'experimentBenefit',
  [VALUE_TIER.IN_USE]: 'inUse',
  [VALUE_TIER.INSTALLED_ONLY]: 'installedOnly',
  [VALUE_TIER.UNKNOWN]: 'unknown',
});

/** A second, independent fact is required before zero usage suggests retirement. */
const CAPABILITY_ASSESSMENT = Object.freeze({
  WORKFLOW_RELEVANT: 'workflow-relevant',
  SELF_CONTAINED: 'self-contained',
  UNKNOWN: 'unknown',
});

const MAX_USAGE_COUNT = 1_000_000_000;

function boundedCount(value) {
  // Do not coerce: Number(null) is 0, which would silently turn an absent count
  // into an explicit zero and unlock a retirement recommendation.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_USAGE_COUNT, Math.floor(value)) : null;
}

function usageRowFor(usage, recordId) {
  const rows = usage?.records;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return null;
  const row = rows[recordId];
  return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
}

/**
 * Whether a zero invocation count may be read as "measured zero".
 *
 * An incomplete scan, an ambiguous tool name or a projection older than its
 * age bound cannot answer "no workflow call ever happened": a plugin published
 * after the snapshot is simply absent from it. Those zeros stay unknown so they
 * can never unlock a retirement recommendation; any positive count is still a
 * fact (the calls demonstrably happened) and is reported as such.
 */
function usageZerosTrusted(usage) {
  if (!usage || typeof usage !== 'object') return false;
  // A projection written before the PTC / plaintext-session scan cannot prove
  // a zero: it would have missed those calls. Positive counts stay facts, but
  // a legacy zero waits for the explicit re-scan.
  return usage.coverage === USAGE_PROJECTION_COVERAGE && usage.complete !== false && usage.stale !== true;
}

function productionBenefitOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { evidenced: false, summary: null };
  return {
    evidenced: value.evidenced === true,
    summary: value.evidenced === true ? boundedText(value.summary ?? '', 240) || null : null,
  };
}

/**
 * The adoption facts a paired-session artifact already recorded.
 *
 * `sessionsUsingCandidate` counts sessions where the *model selected* the
 * candidate, which is structurally zero for a context-policy capability: its
 * value is that no selection is needed. `mechanismRan` is the durable evidence
 * that the candidate actually executed on the real task, so it — not the
 * selection count — is what the review may report as adoption.
 */
function taskBenefitAdoption(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  const adoption = artifact.adoption;
  if (!adoption || typeof adoption !== 'object' || Array.isArray(adoption)) return null;
  const exercised = boundedCount(adoption.sessionsExercised);
  const selected = boundedCount(adoption.sessionsUsingCandidate);
  // The artifact records `mechanismRan` at the top level. Older sidecars do not
  // carry it, so the writer's own rule is re-applied instead of guessing: a
  // context-policy component ran when it transformed a step in a real session,
  // a tool-form candidate ran only when the model selected it.
  const ran = typeof artifact.mechanismRan === 'boolean'
    ? artifact.mechanismRan
    : artifact.improvement === 'context-policy'
      ? (exercised ?? 0) >= 1
      : (selected ?? 0) >= 1;
  return {
    mechanismRan: ran,
    sessionsExercised: exercised,
    sessionsUsingCandidate: selected,
    improvement: typeof artifact.improvement === 'string' ? boundedText(artifact.improvement, 40) : null,
    complete: artifact.complete === true,
  };
}

/**
 * How the published record's `benefit` decision was actually proven.
 *
 * The unified review used to read `stable.decision === 'benefit'` as
 * "experiment benefit" and stop there. That decision is recorded by every
 * promotion, including one whose probe target was the candidate itself and whose
 * baseline therefore recorded "the tool is absent" as the only improvement —
 * a capability self-test, not a workflow before/after. Reading the durable
 * observation distinguishes the two, so an unused self-tested plugin is not
 * reported as if it had demonstrated value.
 *
 * Bounded and read-only: one evidence sidecar per record, size-capped, and any
 * unreadable or older shape stays `unknown` instead of being inferred.
 */
function benefitProvenanceOf(shared, experimentId) {
  const id = typeof experimentId === 'string' ? experimentId : null;
  if (id === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    return { kind: BENEFIT_PROVENANCE.UNKNOWN, basis: null, workflowBenefit: null };
  }
  const file = path.join(shared.dataRoot, 'archive', 'experiments', `${id}.evidence.json`);
  let stat;
  try { stat = fs.statSync(file); } catch { return { kind: BENEFIT_PROVENANCE.UNKNOWN, basis: null, workflowBenefit: null }; }
  if (!stat.isFile() || stat.size > SELF_EVOLUTION_REVIEW_LIMITS.maxBenefitEvidenceBytes) {
    return { kind: BENEFIT_PROVENANCE.UNKNOWN, basis: null, workflowBenefit: null };
  }
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    return { kind: BENEFIT_PROVENANCE.UNKNOWN, basis: null, workflowBenefit: null };
  }
  const observation = evidence?.latestObservation;
  if (!observation || typeof observation !== 'object') {
    return { kind: BENEFIT_PROVENANCE.UNKNOWN, basis: null, workflowBenefit: null };
  }
  const comparison = observation.probe?.comparison;
  const kind = typeof comparison?.benefitKind === 'string' ? comparison.benefitKind : null;
  // A task-coupled artifact is the strongest form: it compared the same real
  // task with and without the candidate. It is recorded on the observation, not
  // on a probe comparison.
  if (observation.taskBenefit?.benefit === true) {
    const artifact = observation.taskBenefit;
    return {
      kind: BENEFIT_PROVENANCE.PAIRED_WORKFLOW,
      basis: boundedText(String(artifact.task?.id ?? observation.observationWindow ?? ''), 120) || null,
      workflowBenefit: true,
      // The same durable artifact answers the adoption question for a
      // capability the model never had to choose: a context-policy plugin
      // changes an existing tool's result, so `sessionsUsingCandidate` is 0 by
      // construction and the mechanism actually running is the real fact.
      adoption: taskBenefitAdoption(artifact),
    };
  }
  // A workflow label only means a paired workflow when the comparison actually
  // carried a workload. A plain probe pair that improved one tool call is a
  // tool-level before/after, not a workflow.
  if (kind === 'workflow' && comparison?.workload && typeof comparison.workload === 'object') {
    return {
      kind: BENEFIT_PROVENANCE.PAIRED_WORKFLOW,
      basis: boundedText(comparison?.workload?.id ?? observation.observationWindow ?? '', 120) || null,
      workflowBenefit: true,
    };
  }
  if (kind === 'tool-improvement') {
    return {
      kind: BENEFIT_PROVENANCE.UNPROVEN,
      basis: boundedText(String(observation.observationWindow ?? ''), 120) || null,
      workflowBenefit: false,
    };
  }
  // The pre-`benefitKind` probe shape still recorded why the baseline target
  // failed. `E_EVOLUTION_PROBE_CAPABILITY_ABSENT` means the candidate was the
  // only thing that changed, which is the definition of a capability self-test.
  const baselineCodes = (comparison?.before?.perStep ?? [])
    .flatMap((step) => Array.isArray(step?.codes) ? step.codes : []);
  const selfTest = kind === 'capability-self-test'
    || baselineCodes.includes('E_EVOLUTION_PROBE_CAPABILITY_ABSENT')
    || /absent before the trial/i.test(String(observation.benefitEvidence ?? ''));
  if (selfTest) {
    return {
      kind: BENEFIT_PROVENANCE.CAPABILITY_SELF_TEST,
      basis: boundedText(String(observation.observationWindow ?? ''), 120) || null,
      workflowBenefit: false,
    };
  }
  // A pre-`benefitKind` comparison whose target step is an existing tool that
  // really ran and failed is a workflow before/after, even without the label.
  const measuredTarget = comparison?.workload && (comparison?.before?.perStep ?? []).some((step) =>
    step?.role === 'target' && Array.isArray(step.codes) && step.codes.length > 0);
  if (measuredTarget) {
    return {
      kind: BENEFIT_PROVENANCE.PAIRED_WORKFLOW,
      basis: boundedText(observation.observationWindow ?? '', 120) || null,
      workflowBenefit: true,
    };
  }
  return {
    kind: BENEFIT_PROVENANCE.UNPROVEN,
    basis: boundedText(String(observation.observationWindow ?? ''), 120) || null,
    workflowBenefit: false,
  };
}

/** Classify one plugin from facts already durably held in the review inputs. */
function valueOf(record, verdicts, usageRow, usageSource, provenance = { kind: BENEFIT_PROVENANCE.UNKNOWN, basis: null, workflowBenefit: null }, zerosTrusted = false, allDisabled = false) {
  const installed = verdicts.some((row) => row.status === 'active');
  // Every published record passed a promotion gate. Whether that gate saw a
  // workflow before/after or only the candidate's own samples is a separate,
  // durable fact; the promotion decision alone does not answer it.
  const recordedBenefit = record.stable?.decision === 'benefit';
  // Only a durable paired comparison satisfies the experiment-benefit rung.
  // The promotion decision alone is not evidence of a workflow improvement, and
  // an unreadable sidecar must not be upgraded into one: "the review cannot
  // disprove it" is not proof.
  const experimentBenefit = recordedBenefit && provenance.kind === BENEFIT_PROVENANCE.PAIRED_WORKFLOW;
  const provenanceReasons = provenance.kind === BENEFIT_PROVENANCE.CAPABILITY_SELF_TEST
    ? ['the recorded benefit came from a capability self-test: the baseline step was the candidate itself, so no workflow before/after was compared']
    : provenance.kind === BENEFIT_PROVENANCE.UNPROVEN
      ? ['no paired workflow comparison is recorded for this promotion; the benefit basis is caller-supplied evidence only']
      : provenance.kind === BENEFIT_PROVENANCE.UNKNOWN
        ? ['no readable promotion evidence sidecar for this record, so the benefit basis is unknown; the recorded benefit decision proves nothing about a workflow']
        : [];
  if (!usageRow) {
    return {
      tier: VALUE_TIER.UNKNOWN,
      installed,
      invoked: null,
      workflowInvocations: null,
      verificationInvocations: null,
      unattributedInvocations: null,
      capabilityAssessment: CAPABILITY_ASSESSMENT.UNKNOWN,
      experimentBenefit,
      benefitProvenance: provenance.kind,
      benefitBasis: provenance.basis,
      productionBenefit: false,
      productionEvidence: null,
      usageSource: null,
      reasons: boundedStrings(['no usage evidence was supplied for this plugin', ...provenanceReasons]),
    };
  }
  // A missing or unusable count is unknown, not zero. Turning it into zero
  // would let a half-filled usage row recommend retirement for a plugin whose
  // usage was never measured.
  const workflowInvocations = boundedCount(usageRow.workflowInvocations);
  const verificationInvocations = boundedCount(usageRow.verificationInvocations);
  const unattributedInvocations = usageRow.unattributedInvocations === undefined
    ? 0 : boundedCount(usageRow.unattributedInvocations);
  // A fully revoked record cannot also carry an unqualified "production
  // benefit is evidenced" claim: that would make the same payload read as both
  // unknown and proven. The historical fact stays in the usage row; the value
  // classification must be internally consistent.
  const production = allDisabled ? { evidenced: false, summary: null } : productionBenefitOf(usageRow.productionBenefit);
  const assessment = Object.values(CAPABILITY_ASSESSMENT).includes(usageRow.capabilityAssessment)
    ? usageRow.capabilityAssessment : CAPABILITY_ASSESSMENT.UNKNOWN;
  // A capability that registers no tool cannot be counted by tool calls at all.
  // That is "not applicable", not "unknown": the projection read its source
  // and the record has no call surface, so the count says nothing about whether
  // the capability ran. It stays `invoked: null` (never a measured zero, so it
  // can never unlock a retirement recommendation) whatever number a persisted
  // projection carries for it.
  const noToolSurface = usageRow.measurement === 'no-tool-surface';
  const adoption = provenance.adoption ?? null;
  // A zero only means "measured zero" when the projection covers every session,
  // the tool name was unambiguous and the snapshot is current. An unresolved
  // call (open lifecycle call in a truncated log) is neither usage nor
  // verification, so it keeps the count unknown rather than zero.
  const invoked = noToolSurface ? null
    : workflowInvocations === null ? null
      : workflowInvocations > 0 ? true
        : !zerosTrusted ? null
          : unattributedInvocations === null || unattributedInvocations > 0 ? null : false;
  const reasons = [
    noToolSurface
      ? 'the capability registers no tool, so a workflow call count does not apply to it; its adoption is reported by the paired workflow evidence'
      : invoked === null
      ? workflowInvocations !== null && workflowInvocations === 0 && !zerosTrusted
        ? 'no workflow invocation is recorded, but the usage projection is incomplete or stale, so zero cannot be treated as measured'
        : workflowInvocations !== null && workflowInvocations === 0 && unattributedInvocations !== null && unattributedInvocations > 0
          ? unattributedInvocations + ' call(s) could not be attributed (the enclosing promotion call never returned)'
          : 'workflow invocation count is not usable in the supplied evidence'
      : workflowInvocations + ' workflow invocation(s) recorded in persisted sessions',
  ];
  if (verificationInvocations > 0) reasons.push(verificationInvocations + ' verification invocation(s) are not usage');
  // The recorded decision is only "experiment benefit" when a workflow
  // comparison produced it; a self-test-only record says so explicitly instead
  // of borrowing the promotion decision as evidence of value.
  if (experimentBenefit) reasons.push('a paired workflow comparison is recorded for this promotion');
  else if (recordedBenefit) reasons.push('the promotion decision records benefit, but its basis is not a workflow comparison');
  if (noToolSurface && adoption && adoption.mechanismRan === true) {
    const sessions = adoption.sessionsExercised === null ? null : adoption.sessionsExercised;
    reasons.push('the paired workflow evidence reports the mechanism ran in '
      + (sessions === null ? 'the recorded number of sessions' : sessions + ' session(s)')
      + ', with the model selecting it in ' + (adoption.sessionsUsingCandidate ?? 0) + ' session(s)');
  } else if (noToolSurface) {
    reasons.push('no paired workflow evidence records the mechanism running, so the capability is mounted but its effect is unproven');
  }
  if (production.evidenced) reasons.push('production benefit is explicitly evidenced: ' + (production.summary ?? 'see source'));
  // Every published record carries an experiment benefit, so usage is the more
  // informative rung here: an unused plugin is reported as experiment-benefit,
  // one that actually runs in sessions as in-use. A count that does not apply
  // (no tool surface) is not a missing measurement, so a proven workflow benefit
  // is reported as such instead of being hidden behind `usage-unknown`.
  const observedTier = production.evidenced ? VALUE_TIER.PRODUCTION_BENEFIT
    : noToolSurface
      ? experimentBenefit ? VALUE_TIER.EXPERIMENT_BENEFIT : installed ? VALUE_TIER.INSTALLED_ONLY : VALUE_TIER.UNKNOWN
      : invoked === null ? VALUE_TIER.UNKNOWN
        : invoked ? VALUE_TIER.IN_USE
          : experimentBenefit ? VALUE_TIER.EXPERIMENT_BENEFIT
            : installed ? VALUE_TIER.INSTALLED_ONLY : VALUE_TIER.UNKNOWN;
  // An explicitly revoked record is out of the reuse chain. Historical counts
  // remain facts and are still reported, but they cannot prove *current* reuse;
  // reporting in-use / production-benefit for a fully revoked record would
  // inflate the value summary and hide the restart action the owner still owes.
  // `allDisabled` comes from the revocation table, not from consumer state: a
  // stale or absent consumer row must not narrow or widen the revocation scope.
  const tier = allDisabled ? VALUE_TIER.UNKNOWN : observedTier;
  if (allDisabled) reasons.push('the record was revoked on every approved profile; recorded invocations are historical and do not prove current reuse');
  return {
    tier,
    installed,
    invoked,
    measurement: noToolSurface ? 'no-tool-surface' : null,
    adoption,
    workflowInvocations,
    verificationInvocations,
    unattributedInvocations,
    capabilityAssessment: assessment,
    experimentBenefit,
    benefitProvenance: provenance.kind,
    benefitBasis: provenance.basis,
    productionBenefit: production.evidenced,
    productionEvidence: production.summary,
    usageSource: typeof usageSource === 'string' ? boundedText(usageSource, 80) || null : null,
    reasons: boundedStrings([...reasons, ...provenanceReasons]),
  };
}

/** A bounded, reversible recommendation. The review never disables anything. */
function retirementFor(record, value) {
  // Zero invocations alone is never a verdict: success counters are not durable
  // and a young plugin may simply not have been chosen yet. Require an explicit,
  // usable zero, a second fact — a self-contained capability whose inputs are
  // caller-supplied — and the absence of any evidenced production benefit.
  if (!value.installed || value.invoked !== false || value.productionBenefit) return null;
  if (value.capabilityAssessment !== CAPABILITY_ASSESSMENT.SELF_CONTAINED) return null;
  const script = scriptPath();
  return {
    recordId: record.id,
    pluginName: record.pluginName,
    profiles: [...record.approvedProfiles],
    tier: value.tier,
    reasons: boundedStrings([
      'no persisted workflow invocation recorded',
      'capability is self-contained: its inputs are caller-supplied and it has no independent data source',
      value.benefitProvenance === BENEFIT_PROVENANCE.PAIRED_WORKFLOW
        ? 'a paired workflow comparison is recorded, but no workflow invocation followed'
        : 'the recorded benefit is not a workflow comparison (' + value.benefitProvenance + ')',
    ]),
    evidence: {
      workflowInvocations: value.workflowInvocations,
      verificationInvocations: value.verificationInvocations,
      unattributedInvocations: value.unattributedInvocations,
      experimentBenefit: value.experimentBenefit,
      benefitProvenance: value.benefitProvenance,
      productionBenefit: false,
    },
    suggestion: 'review with the owner; if confirmed, disable with the shared-plugins CLI (reversible with enable). Do not delete the publication record or the experience history.',
    ...(script ? { commands: record.approvedProfiles.slice(0, 4).map((profile) =>
      'node ' + JSON.stringify(script) + ' disable --profile ' + JSON.stringify(profile) + ' --plugin ' + JSON.stringify(record.id)) } : {}),
    requiresOwnerAuthorization: true,
    reversible: true,
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
  // (the same shared rule the cross-entry consumer uses) so a real host is
  // still classified instead of every record becoming unverified.
  if (hostFactsComplete(host)) return host;
  let detected = null;
  try { detected = detectHostIdentity(); } catch { detected = null; }
  return completeHostFacts(host, detected);
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

function profileVerdict(row, { profile, hostDigest: currentDigest, restartPending, stateStatus, recordHost, consumerHost, reviewHost }) {
  if (stateStatus !== 'ok') return { profile, status: 'unverified', reason: 'consumer-state-' + stateStatus, current: false };
  if (row === null || row === undefined) return { profile, status: 'unverified', reason: 'no-activation-record', current: false };
  const status = typeof row.status === 'string' ? row.status : 'unknown';
  const reason = typeof row.reason === 'string' ? row.reason : null;
  const current = typeof row.hostDigest === 'string' && row.hostDigest === currentDigest;
  // A stale failure or incompatibility row written by a consumer running a
  // different host is not repaired by restarting that consumer: it will
  // re-evaluate under the same old host and refuse the record again. Only a new
  // revalidation on that host can clear it. Require two known DSH identities so
  // a missing host fact degrades conservatively without a fabricated mismatch.
  const hostVerdict = recordHost && typeof recordHost === 'object'
    && consumerHost && typeof consumerHost === 'object'
    && typeof recordHost.dsh === 'string' && typeof consumerHost.dsh === 'string'
    ? hostCompatible(recordHost, consumerHost) : null;
  // A consumer state carries the host from its LAST start. After an adopted
  // revalidation the record and the live host already agree, while that state
  // still names the old host. Treating the stale row as a live mismatch asks for
  // another revalidation that the runner will refuse ("nothing to revalidate")
  // and blocks the restart that would actually clear it. The live review host is
  // the authority for whether the record is compatible now; the consumer host
  // remains useful only as a displayed fact and as a fallback when no live host
  // was supplied (older callers).
  const reviewVerdict = recordHost && typeof recordHost === 'object'
    && reviewHost && typeof reviewHost === 'object'
    && typeof recordHost.dsh === 'string' && typeof reviewHost.dsh === 'string'
    ? hostCompatible(recordHost, reviewHost) : null;
  const knownHostMismatch = hostVerdict !== null && hostVerdict.ok !== true;
  // A consumer on a compatible patch of the same host (e.g. Cordis 4.1.1 vs
  // 4.1.0) has a different exact hostDigest but will fail the same way after a
  // restart: it remembers failures by that exact digest. Such a failure is a
  // real apply failure on this host, not a stale row fixed by restarting.
  const hostFamilyCompatible = hostVerdict !== null && hostVerdict.ok === true;
  switch (status) {
    case 'active':
      return { profile, status: restartPending ? 'restart-required' : 'active', reason: restartPending ? 'index-changed-since-consumer-start' : null, current };
    case 'failed':
      if (reason === 'include-unavailable') return { profile, status: 'host-unavailable', reason, current };
      if (knownHostMismatch) return { profile, status: 'pending-revalidation', reason: hostVerdict.reason, current };
      return current || hostFamilyCompatible
        ? { profile, status: 'apply-failed', reason: reason || 'previous-failure', current }
        : { profile, status: 'stale-failure', reason: reason || 'previous-failure', current };
    case 'skipped-incompatible':
      if (knownHostMismatch) return { profile, status: 'pending-revalidation', reason: hostVerdict.reason, current };
      return current || hostFamilyCompatible
        ? { profile, status: 'incompatible', reason: reason || 'missing-host-capability', current }
        : { profile, status: 'stale-incompatible', reason: reason || 'missing-host-capability', current };
    case 'skipped-invalid':
      return { profile, status: 'invalid', reason: reason || 'record-invalid', current };
    case 'pending-revalidation': {
      // A restart only helps when the record is already compatible with the
      // LIVE host. The consumer's stored host is the one from its previous
      // start: after an adopted revalidation it can still name the old host,
      // and restarting is exactly how it picks up the new one. When the live
      // host itself disagrees with the record, only a new revalidation can
      // clear the mismatch.
      // A restart only helps when the consumer has NOT yet observed the current
      // index: then its next start re-evaluates under the live host. A consumer
      // that already read the current generation and still reports pending on a
      // different host has a genuine per-profile mismatch whose revalidation
      // evidence must come from that host.
      const restartHelps = restartPending === true && (reviewVerdict ?? hostVerdict)?.ok === true;
      const mismatchReason = restartHelps ? null : ((reviewVerdict ?? hostVerdict)?.reason || 'host-version-mismatch');
      return { profile, status: restartHelps ? 'stale-revalidation' : 'pending-revalidation', reason: reason && reason !== 'host-version-mismatch' ? reason : mismatchReason, current };
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

function describeHostFacts(host) {
  if (!host || typeof host !== 'object') return 'unknown host';
  const parts = ['DSH ' + boundedText(String(host.dsh ?? 'unknown'), 40)];
  for (const name of ['cordis', 'include', 'node']) {
    if (host[name] != null) parts.push(name[0].toUpperCase() + name.slice(1) + ' ' + boundedText(String(host[name]), 40));
  }
  return parts.join(', ');
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

/** One bounded, ordered action projection shared by every review outcome. */
function boundedReviewActions(actions = []) {
  const ordered = orderStableActions(actions);
  let nextActions = ordered.slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxActions);
  // A page of malformed records can fill every operator slot. The bounded-read
  // notices are the only facts that say the review is incomplete, so reserve
  // bounded slots for them instead of letting them fall off.
  const notices = ordered.filter((row) => row.code === 'review-record-cap' || row.code === 'consumer-rows-truncated');
  const missing = notices.filter((row) => !nextActions.includes(row));
  if (missing.length > 0) {
    const room = Math.max(0, SELF_EVOLUTION_REVIEW_LIMITS.maxActions - missing.length);
    nextActions = [...nextActions.filter((row) => !notices.includes(row)).slice(0, room), ...missing];
  }
  return { nextActions, nextActionsDropped: ordered.length - nextActions.length };
}
/**
 * Read and classify every published stable plugin against one live host.
 *
 * The function never throws for an unreadable index, revocation table or
 * source: those are facts the review reports (with a closed reason), because a
 * self-evolution request must not fail merely because one durable record is
 * damaged. Only a missing data root is a caller error.
 */
export async function readPublishedPluginReview({ paths, host, usage = null, usageStatus = null } = {}) {
  const shared = sharedPathsFor(paths);
  const summary = {
    total: 0, active: 0, pendingRevalidation: 0, incompatible: 0, restartRequired: 0,
    hostUnavailable: 0, inactive: 0, invalid: 0, sourceUnusable: 0, blocked: 0, verifyHost: 0,
  };
  const valueSummary = {
    productionBenefit: 0, experimentBenefit: 0, inUse: 0, installedOnly: 0, unknown: 0,
    retirementCandidates: 0,
  };
  const retirementCandidates = [];
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
    // Provenance of the optional, read-only usage projection. No scan is started
    // here: without it every record is honestly reported as `usage-unknown`.
    usageEvidence: {
      source: typeof usage?.source === 'string' ? boundedText(usage.source, 80) || null : null,
      capturedAt: typeof usage?.capturedAt === 'string' ? boundedText(usage.capturedAt, 40) || null : null,
      status: typeof usageStatus === 'string' ? boundedText(usageStatus, 40)
        : typeof usage?.status === 'string' ? boundedText(usage.status, 40) : null,
      complete: usage ? usage.complete !== false : null,
      recordsComplete: usage ? usage.recordsComplete !== false : null,
      stale: usage ? usage.stale === true : null,
      recordCount: usage?.records && typeof usage.records === 'object' && !Array.isArray(usage.records)
        ? Object.keys(usage.records).length : 0,
    },
    retirementCandidates,
    invalidRecords: (Array.isArray(index.invalid) ? index.invalid : []).slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxInvalidRecords).map((row) => ({
      index: Number.isInteger(row?.index) ? row.index : null,
      id: typeof row?.id === 'string' ? boundedText(row.id, 120) : null,
      reason: boundedText(row?.reason, 80) || 'invalid-record',
    })),
    consumers: Object.fromEntries(SHARED_CONSUMER_PROFILES.map((profile) => {
      const state = consumers[profile];
      // The projection below is bounded, but the row count is not: a consumer
      // can report more activation rows than this review reads. Keep the true
      // count so an unread row (for example an orphan active mount doctor names)
      // cannot be mistaken for a complete, healthy review.
      const allRows = Array.isArray(state.state?.plugins) ? state.state.plugins : [];
      return [profile, {
        status: state.status,
        updatedAt: typeof state.state?.updatedAt === 'string' ? boundedText(state.state.updatedAt, 40) : null,
        observedIndexUpdatedAt: typeof state.state?.observedIndexUpdatedAt === 'string' ? boundedText(state.state.observedIndexUpdatedAt, 40) : null,
        needsRestart: Boolean(state.state) && consumerNeedsRestart(index.updatedAt, state.state),
        rowCount: allRows.length,
        rowsTruncated: allRows.length > SELF_EVOLUTION_REVIEW_LIMITS.maxRecords,
        rows: allRows.slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxRecords).map((row) => ({
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

  // A consumer can report more activation rows than the bounded projection
  // above evaluates. Never invent a per-row status for the unread tail: emit
  // one bounded owner-facing notice per affected profile and point at the
  // doctor's promotion.sharing check, which reads every row.
  const consumerRowsTruncated = SHARED_CONSUMER_PROFILES.filter((profile) => base.consumers[profile]?.rowsTruncated === true);
  base.consumerRowsTruncated = consumerRowsTruncated;
  for (const profile of consumerRowsTruncated) {
    const rowCount = base.consumers[profile].rowCount;
    base.nextActions.push({
      action: REVIEW_ACTIONS.OPERATOR,
      code: 'consumer-rows-truncated',
      profile,
      recordId: null,
      why: boundedText(`consumer ${profile} reports ${rowCount} activation rows; only the first ${SELF_EVOLUTION_REVIEW_LIMITS.maxRecords} are evaluated and ${rowCount - SELF_EVOLUTION_REVIEW_LIMITS.maxRecords} row(s) are not evaluated, so an orphan active mount can hide here; the doctor promotion.sharing check reads every row`),
    });
  }

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
        code: 'invalid-record',
        recordId: typeof invalid?.id === 'string' ? boundedText(invalid.id, 120) : null,
        why: 'a published record failed validation: ' + (boundedText(invalid?.reason, 80) || 'invalid-record'),
      });
    }
  }

  // A readable index can still drop one record or unapprove one profile while
  // the consumer keeps that plugin mounted. Derive the orphan rows from the
  // bounded consumer projection the same way doctor does; a restart is the only
  // way to unload them, so neither surface may call this scene healthy.
  const indexRecords = Array.isArray(index.records) ? index.records : [];
  const orphanMounts = [];
  for (const profile of SHARED_CONSUMER_PROFILES) {
    for (const row of base.consumers[profile]?.rows ?? []) {
      if (orphanMounts.length >= SELF_EVOLUTION_REVIEW_LIMITS.maxRecords) break;
      if (row?.status !== 'active' || typeof row.id !== 'string' || row.id === '') continue;
      const record = indexRecords.find((entry) => entry?.id === row.id);
      if (record && Array.isArray(record.approvedProfiles) && record.approvedProfiles.includes(profile)) continue;
      orphanMounts.push({
        profile,
        id: boundedText(row.id, 120),
        reason: record ? 'profile-not-approved' : 'record-missing',
      });
    }
  }
  base.orphanMounts = orphanMounts;
  for (const orphan of orphanMounts) {
    base.nextActions.push({
      action: REVIEW_ACTIONS.RESTART,
      recordId: orphan.id,
      profiles: [orphan.profile],
      // composeSelfEvolutionReview dedups on action + recordId + profile + code;
      // keep one distinct entry per orphaned profile so no mount is lost.
      profile: orphan.profile,
      code: 'orphan-active-mount',
      why: `the publication index no longer includes ${orphan.id} for ${orphan.profile}, but that consumer still reports it active; restart ${orphan.profile} to unload it`,
    });
  }

  if (index.status === 'absent' && orphanMounts.length === 0) {
    return { ...base, status: 'absent', reason: 'no published stable plugin' };
  }
  if (index.status === 'absent') {
    return {
      ...base,
      status: 'restart-required',
      reason: 'orphan-active-mount',
      ...boundedReviewActions(base.nextActions),
    };
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

  // A damaged revocation table is a safety condition even when the index has
  // no valid records to evaluate: consumers fail closed before any mount, and a
  // future publication would be refused until the table is repaired. Doctor
  // reports the same scene as blocked, so an empty index cannot compose to
  // no-action while the safety table is unreadable.
  if (index.records.length === 0 && (disable.status === 'invalid' || disable.status === 'unreadable')) {
    const operator = {
      action: REVIEW_ACTIONS.OPERATOR,
      code: 'revocation-table-unreadable',
      recordId: null,
      why: 'The per-profile revocation table is ' + disable.status + '; consumers refuse every record until it is repaired.',
    };
    const kept = base.nextActions.slice(0, Math.max(0, SELF_EVOLUTION_REVIEW_LIMITS.maxActions - 1));
    return {
      ...base,
      status: 'blocked',
      reason: 'revocation-table-unreadable',
      summary: { ...summary, blocked: 1 },
      nextActions: [...kept, operator],
      nextActionsDropped: Math.max(0, base.nextActions.length - kept.length),
    };
  }

  // The bounded scan never invents a per-record status for rows it did not read.
  // It does emit one owner-facing, blocking action so a broken plugin past the
  // cap cannot be mistaken for a complete clean review. Only the count and a
  // bounded sample of omitted ids are read - the omitted rows are not scanned.
  if (base.truncated && index.status === 'ok') {
    const omittedCount = index.records.length - SELF_EVOLUTION_REVIEW_LIMITS.maxRecords;
    const sample = index.records
      .slice(SELF_EVOLUTION_REVIEW_LIMITS.maxRecords, SELF_EVOLUTION_REVIEW_LIMITS.maxRecords + SELF_EVOLUTION_REVIEW_LIMITS.maxTruncatedSampleIds)
      .map((row) => (typeof row?.id === 'string' ? boundedText(row.id, 120) : null))
      .filter(Boolean);
    const sampleText = sample.length > 0
      ? ` (${sample.join(', ')}${omittedCount > sample.length ? ', …' : ''})`
      : '';
    base.nextActions.push({
      action: REVIEW_ACTIONS.OPERATOR,
      code: 'review-record-cap',
      recordId: null,
      why: `${omittedCount} published record(s) past the ${SELF_EVOLUTION_REVIEW_LIMITS.maxRecords}-record cap were not evaluated${sampleText}; this review is incomplete.`,
    });
  }

  const currentDigest = host && typeof host === 'object' ? hostDigest(host) : null;
  const zerosTrusted = usageZerosTrusted(usage);
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
      // blocker by itself. A consumer that still reports the record as active
      // has not picked up the revocation, so it needs a restart to unmount it.
      const stillMounted = record.approvedProfiles.filter((profile) => (consumers[profile]?.state?.plugins || [])
        .some((row) => row.id === record.id && row.status === 'active'));
      if (stillMounted.length > 0) {
        status = RECORD_STATUS.RESTART_REQUIRED;
        action = REVIEW_ACTIONS.RESTART;
        reasons.push(stillMounted.map((profile) => profile + ': still mounted after revocation').join('; '));
      } else {
        status = RECORD_STATUS.INACTIVE;
        action = null;
      }
      for (const profile of record.approvedProfiles) {
        verdicts.push({ profile, status: stillMounted.includes(profile) ? 'restart-required' : 'disabled',
          reason: stillMounted.includes(profile) ? 'active-after-revocation' : 'operator-disabled', current: true });
      }
    } else if (disable.status === 'invalid' || disable.status === 'unreadable') {
      // Consumer evaluation fails closed on the revocation table before it
      // even reads the record's host, so a host mismatch cannot turn this into
      // "revalidate": the only actionable fact is the damaged safety table.
      // Doctor reports the same scene as blocked; keep the precedence here.
      status = RECORD_STATUS.BLOCKED;
      action = REVIEW_ACTIONS.OPERATOR;
      reasons.push('the per-profile revocation table is ' + disable.status + '; consumers refuse every record');
    } else if (!hostKnown) {
      status = RECORD_STATUS.VERIFY_HOST;
      action = REVIEW_ACTIONS.VERIFY_HOST;
      reasons.push('the live host identity is unavailable so compatibility cannot be proven');
    } else if (hostVerdict.ok === false) {
      status = RECORD_STATUS.PENDING_REVALIDATION;
      action = REVIEW_ACTIONS.REVALIDATE;
      reasons.push('recorded host does not match the live host (' + hostVerdict.reason + ')');
    } else {
      for (const profile of record.approvedProfiles) {
        const state = consumers[profile] ?? { status: 'unreadable', state: null };
        if (isDisabledForProfile(disable, record.id, profile)) {
          // A single revoked profile still needs its mount dropped when that
          // consumer has not yet observed the revocation.
          const stillMounted = (state.state?.plugins ?? []).some((entry) => entry.id === record.id && entry.status === 'active');
          verdicts.push({ profile, status: stillMounted ? 'restart-required' : 'disabled',
            reason: stillMounted ? 'active-after-revocation' : 'operator-disabled', current: true });
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
          reviewHost: host,
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

    // A pending-revalidation profile can coexist with a different aggregate
    // action (for example one profile needs a source repair while another is
    // still on an old host). Emitting only the aggregate action silently drops
    // the revalidation instruction, so after the first repair is applied the
    // second profile still refuses to mount with no owner-facing next step.
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
    const pushRevalidationInstruction = (rows) => {
      // Name the real cause. A record-level mismatch is about this host; a
      // per-profile pending row on an otherwise matching record means a
      // consumer last booted on another host, which a restart cannot fix by
      // itself. In that case the action must name the profile and the host its
      // evidence has to come from, instead of repeating "the current host".
      const splitHosts = hostVerdict.ok !== false && rows.length > 0;
      const cause = hostVerdict.ok === false
        ? 'the live host does not match (' + boundedText(String(hostVerdict.reason ?? 'host-mismatch'), 80) + ')'
        : splitHosts
          ? 'consumer ' + rows.map((row) => row.profile + ' runs ' + describeHostFacts(consumerHostFacts(row.profile))).join(', ') + ' instead of the verified ' + describeHostFacts(record.host)
          : 'a consumer host does not match';
      const instruction = revalidationInstruction(record, resolvedScriptPath, boundedText(cause, 220));
      if (splitHosts) {
        instruction.profiles = rows.map((row) => row.profile);
        instruction.consumerHosts = Object.fromEntries(rows.map((row) => [row.profile, consumerHostFacts(row.profile)]));
        instruction.prerequisite = 'A restart alone cannot clear this: align the named consumer with ' + describeHostFacts(record.host) + '. Only if it must keep a different host, verify these exact bytes on that host; entries still on another host then report pending-revalidation.';
        instruction.evidence = 'A real isolated-host cross-entry verification report for this exact plugin id and sourceSha256 on the host facts named by consumerHosts; adopting it makes entries still on another host pending until they are aligned.';
      }
      if (resolvedScriptPath === null) delete instruction.command;
      base.nextActions.push(instruction);
    };
    if (action === REVIEW_ACTIONS.REVALIDATE) {
      pushRevalidationInstruction(mismatched);
    } else if (action && action !== REVIEW_ACTIONS.NONE) {
      base.nextActions.push({
        action,
        recordId: record.id,
        why: reasons[0] ?? 'stable plugin is ' + status,
        ...(status === RECORD_STATUS.INCOMPATIBLE ? { rootCauseHint: 'read the consumer failure reason and the recorded experience before proposing the smallest fix' } : {}),
      });
      if (mismatched.length > 0) pushRevalidationInstruction(mismatched);
      // A record can need a source repair for one profile while another profile
      // merely needs a restart after an adopted revalidation. The aggregate
      // action is the repair; without a profile-named follow-up the owner fixes
      // the source and the second profile still refuses to mount.
      const restartProfiles = action === REVIEW_ACTIONS.RESTART ? []
        : verdicts.filter((row) => row.status === 'stale-revalidation' || row.status === 'restart-required').map((row) => row.profile);
      if (restartProfiles.length > 0) {
        base.nextActions.push({
          action: REVIEW_ACTIONS.RESTART,
          recordId: record.id,
          profiles: restartProfiles,
          why: 'restart the consumer profiles whose activation row predates the now-compatible record',
        });
      }
    }

    const value = valueOf(record, verdicts, usageRowFor(usage, record.id), usage?.source, benefitProvenanceOf(shared, record.experimentId), zerosTrusted, allDisabled);
    const retirement = retirementFor(record, value);
    if (retirement) {
      retirementCandidates.push(retirement);
      valueSummary.retirementCandidates += 1;
      // The usage verdict is only useful if it reaches the ordered decision:
      // report it as a bounded, owner-only and reversible next action. The
      // review never disables anything itself.
      base.nextActions.push({
        action: REVIEW_ACTIONS.RETIRE,
        recordId: record.id,
        why: 'no persisted workflow invocation and no evidenced production benefit are recorded for this self-contained published plugin',
        evidence: retirement.evidence,
        profiles: [...retirement.profiles],
        ...(retirement.commands ? { commands: retirement.commands } : {}),
        requiresOwnerAuthorization: true,
        reversible: true,
      });
    }
    const valueBucket = VALUE_SUMMARY_KEY[value.tier];
    if (valueBucket) valueSummary[valueBucket] += 1;

    records.push({
      id: record.id,
      experimentId: record.experimentId,
      pluginName: record.pluginName,
      approvedProfiles: [...record.approvedProfiles],
      status,
      action,
      source,
      value,
      ...(retirement ? { retirement: { candidate: true, requiresOwnerAuthorization: true, reversible: true } } : {}),
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

  const statusFromSummary = summary.blocked > 0 || summary.sourceUnusable > 0 || summary.invalid > 0
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
              : 'inactive';
  const status = orphanMounts.length > 0
    && !['blocked', 'pending-revalidation', 'incompatible'].includes(statusFromSummary)
    ? 'restart-required'
    : statusFromSummary;
  return {
    ...base,
    status,
    records,
    valueSummary,
    retirementCandidates: retirementCandidates.slice(0, SELF_EVOLUTION_REVIEW_LIMITS.maxRecords),
    ...boundedReviewActions(base.nextActions),
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
  let none = planned.none ?? null;
  // An empty plan caused by an unreachable store is not the same fact as
  // "history has no failure signal"; report the store itself as the reason.
  // Both ways of being unreachable matter: no store object was supplied, and a
  // store that threw while reading. The orchestrator's plan() classifies both
  // through the same `shared-knowledge` source, so this read-only surface must
  // not claim "no failure signal" in either case.
  const storeUnavailable = errors.some((entry) => entry.reason === 'shared-experience-store-unavailable'
    || entry.reason === 'shared-experience-unreadable');
  if (none && none.reason === 'no-failure-signal' && knowledge.length === 0 && storeUnavailable) {
    none = { reason: 'store-unavailable', considered: 0, detail: 'the unified experience store is unavailable and local failure memory did not supply a candidate' };
  }
  // The same honesty rule applies to a withheld discovery window: an older
  // problem outside the bounded read is not "no failure signal".
  if (none && none.reason === 'no-failure-signal' && truncated) {
    none = { ...none, reason: 'discovery-window-truncated', detail: 'the bounded discovery window withheld older facts; filtering the records already read cannot recover them, so this is not evidence of no failure signal' };
  }
  return {
    available: errors.length === 0 || knowledge.length > 0,
    applicability,
    applicabilityVerified: reviewApplicabilityKnown(applicability),
    selected: planned.selected ?? null,
    candidates: planned.candidates ?? [],
    none,
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
    const key = String(action.action) + '\u0000' + String(action.recordId ?? '') + '\u0000' + String(action.problemKey ?? '')
      + '\u0000' + String(action.profile ?? '') + '\u0000' + String(action.code ?? '');
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
    const selected = experience.selected;
    // The planner's form is part of the action, not prose: a consumer that
    // starts an experiment from this review must not silently fall back to a
    // new tool when the evidence calls for changing the existing result path.
    const form = selected.improvement === 'tool' || selected.improvement === 'context-policy' ? selected.improvement : null;
    const recoveryTools = form === 'context-policy' && Array.isArray(selected.baselinePath?.recoveryTools)
      ? selected.baselinePath.recoveryTools.slice(0, 3).map((tool) => boundedText(tool, 80)).filter(Boolean)
      : [];
    // A tool scope can carry several losses; the action names each one's own
    // cost so a capability that already solved one kind is not read as solving
    // the other. Bounded and copied from the planner, never recomputed here.
    const lossKinds = Array.isArray(selected.loss?.breakdown)
      ? selected.loss.breakdown.slice(0, 3).map((row) => ({
        kind: boundedText(row.kind, 80),
        occurrences: Number.isInteger(row.occurrences) ? row.occurrences : 0,
        recoveryCalls: Number.isInteger(row.recoveryCalls) ? row.recoveryCalls : 0,
        recoveryTools: (Array.isArray(row.recoveryTools) ? row.recoveryTools : [])
          .slice(0, 3).map((tool) => boundedText(tool, 80)).filter(Boolean),
      }))
      : [];
    push({
      action: REVIEW_ACTIONS.EXPERIENCE,
      problemKey: selected.problemKey,
      why: selected.occurrences + ' recorded occurrence(s); expected: ' + boundedText(selected.expectedImprovement, 160),
      requiresNewHypothesis: selected.requiresNewHypothesis === true,
      ...(form ? { improvement: form } : {}),
      ...(form && selected.verificationKind ? { verificationKind: boundedText(selected.verificationKind, 40) } : {}),
      ...(recoveryTools.length > 0 ? { baselineRecoveryTools: recoveryTools } : {}),
      ...(lossKinds.length > 0 ? { lossKinds } : {}),
      ...(selected.mixedOrigin === true ? { mixedOrigin: true } : {}),
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
      valueSummary: stable.valueSummary ?? null,
      retirementCandidates: Array.isArray(stable.retirementCandidates) ? stable.retirementCandidates.length : 0,
      nextActions: Array.isArray(stable.nextActions) ? stable.nextActions.length : 0,
      nextActionsDropped: Number.isInteger(stable.nextActionsDropped) ? stable.nextActionsDropped : 0,
      consumerRowsTruncated: Array.isArray(stable.consumerRowsTruncated)
        ? stable.consumerRowsTruncated.slice(0, SHARED_CONSUMER_PROFILES.length) : [],
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
      || stable?.truncated === true
      // A consumer with more activation rows than the review reads can hide a
      // problem in the unread tail; the doctor's promotion.sharing check reads
      // every row, while this review must stay explicitly incomplete.
      || (Array.isArray(stable?.consumerRowsTruncated) && stable.consumerRowsTruncated.length > 0)
      // A bounded discovery window that withheld older facts is not a complete
      // review, even when every row we did read looked conclusive.
      || experience?.sources?.truncated === true,
    readOnly: true,
  };
}
