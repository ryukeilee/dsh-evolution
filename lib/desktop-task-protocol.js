/**
 * Shared protocol for the ACP → Desktop evolution task channel.
 *
 * Both sides of the channel are separate processes that share one DSH_HOME:
 * the `desktop-task-host` entry runs inside the official Desktop runtime and
 * owns every task state file, while `desktop-task-client` runs inside the ACP
 * profile and only writes requests and bound owner approvals. This module has
 * no process or profile assumptions: it validates the on-disk documents,
 * decides legal phase transitions, and performs the atomic file operations the
 * channel needs. It never imports official packages and never talks to a
 * network service.
 *
 * Trust boundary: the directory is 0700 and every file 0600, but any process
 * of the same OS user can write it. It is a transport, not an authorization
 * boundary — promotion authority stays inside the Desktop Evolution kernel
 * (eight gates + explicit owner confirmation).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const EXPERIMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
export const PROFILE_NAMES = Object.freeze(['acp', 'web']);
export const PHASES = Object.freeze([
  'accepted',
  'running',
  'awaiting-owner-confirmation',
  'promoting',
  'canary-observing',
  'stable',
  'failed',
  'interrupted',
  'cancelled',
]);
export const TERMINAL_PHASES = Object.freeze(['stable', 'failed', 'interrupted', 'cancelled']);
export const MAX_HOST_CODE_BYTES = 48 * 1024;
export const MAX_TASK_TEXT = 4000;
export const MAX_SAMPLES = 5;
export const MAX_OBSERVATIONS = 5;

const ALLOWED_TRANSITIONS = Object.freeze({
  accepted: Object.freeze(['running', 'failed', 'interrupted', 'cancelled']),
  running: Object.freeze(['awaiting-owner-confirmation', 'promoting', 'stable', 'failed', 'interrupted', 'cancelled']),
  'awaiting-owner-confirmation': Object.freeze(['promoting', 'stable', 'failed', 'interrupted', 'cancelled']),
  promoting: Object.freeze(['canary-observing', 'stable', 'failed', 'interrupted']),
  'canary-observing': Object.freeze(['stable', 'failed', 'interrupted']),
  stable: Object.freeze([]),
  failed: Object.freeze([]),
  interrupted: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** Every path the channel touches, derived from one DSH_HOME. */
export function taskChannelPaths(dshHome) {
  const root = path.join(path.resolve(dshHome), 'storages', 'evolution', 'desktop-tasks');
  return {
    root,
    ready: path.join(root, 'host.json'),
    inbox: path.join(root, 'inbox'),
    state: path.join(root, 'state'),
    approvals: path.join(root, 'approvals'),
    claims: path.join(root, 'claims'),
  };
}

export function isTerminalPhase(phase) {
  return TERMINAL_PHASES.includes(phase);
}

export function canTransition(from, to) {
  return Array.isArray(ALLOWED_TRANSITIONS[from]) && ALLOWED_TRANSITIONS[from].includes(to);
}

/** SHA-256 of the candidate Host composition exactly as the task supplied it. */
export function candidateSourceDigest(hostCode) {
  if (typeof hostCode !== 'string') throw new Error('candidate source must be a string');
  return crypto.createHash('sha256').update(hostCode).digest('hex');
}

/** A deterministic, collision-resistant task identity minted by the client. */
export function mintTaskId(now = Date.now(), random = crypto.randomBytes(4).toString('hex')) {
  return `desktop-task-${now.toString(36)}-${random}`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLosslessJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isLosslessJson(value[index], ancestors)) return false;
      }
      return true;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Object.keys(value)) {
      if (!isLosslessJson(value[key], ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function boundedString(value, field, max) {
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.length === 0) return `${field} must not be empty`;
  if (value.length > max) return `${field} must be at most ${max} characters`;
  return null;
}

function boundedStringArray(value, field, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length === 0) return `${field} must be a non-empty array`;
  if (value.length > maxItems) return `${field} must contain at most ${maxItems} items`;
  for (let index = 0; index < value.length; index += 1) {
    const issue = boundedString(value[index], `${field}[${index}]`, maxLength);
    if (issue !== null) return issue;
  }
  return null;
}

function issue(result, message) {
  if (message !== null) result.issues.push(message);
  return message === null;
}

/**
 * Validate one task request. Unknown fields are rejected so a newer client
 * cannot silently lose semantics on an older host.
 */
export function validateTaskRequest(value) {
  const issues = [];
  const ok = () => issues.length === 0;
  if (!isRecord(value)) return { ok: false, issues: ['request must be an object'] };
  const allowed = ['schemaVersion', 'protocol', 'taskId', 'createdAt', 'requester', 'plan', 'cwd'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`unexpected field: ${key}`);
  if (value.schemaVersion !== SCHEMA_VERSION) issues.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (value.protocol !== PROTOCOL_VERSION) issues.push(`protocol must be ${PROTOCOL_VERSION}`);
  if (typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId)) issues.push('taskId is invalid');
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) issues.push('createdAt must be an ISO timestamp');
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd))) issues.push('cwd must be an absolute path when present');
  if (!isRecord(value.requester)) issues.push('requester must be an object');
  else {
    if (value.requester.profile !== 'acp') issues.push('requester.profile must be acp');
    if (value.requester.sessionId !== undefined) {
      issue({ issues }, boundedString(value.requester.sessionId, 'requester.sessionId', 200));
    }
  }
  const plan = value.plan;
  if (!isRecord(plan)) issues.push('plan must be an object');
  else {
    const planAllowed = ['proposal', 'composition', 'verification', 'requestedTargetProfiles'];
    for (const key of Object.keys(plan)) if (!planAllowed.includes(key)) issues.push(`unexpected plan field: ${key}`);
    const proposal = plan.proposal;
    if (!isRecord(proposal)) issues.push('plan.proposal must be an object');
    else {
      for (const key of Object.keys(proposal)) if (!['why', 'target', 'impactScope', 'successMetrics'].includes(key)) issues.push(`unexpected proposal field: ${key}`);
      issue({ issues }, boundedString(proposal.why, 'plan.proposal.why', 4000));
      issue({ issues }, boundedString(proposal.target, 'plan.proposal.target', 500));
      issue({ issues }, boundedStringArray(proposal.impactScope, 'plan.proposal.impactScope', 16, 200));
      issue({ issues }, boundedStringArray(proposal.successMetrics, 'plan.proposal.successMetrics', 16, 500));
    }
    const composition = plan.composition;
    if (!isRecord(composition)) issues.push('plan.composition must be an object');
    else {
      for (const key of Object.keys(composition)) if (!['name', 'purpose', 'code'].includes(key)) issues.push(`unexpected composition field: ${key}`);
      issue({ issues }, boundedString(composition.name, 'plan.composition.name', 120));
      issue({ issues }, boundedString(composition.purpose, 'plan.composition.purpose', 500));
      const code = composition.code;
      if (!isRecord(code)) issues.push('plan.composition.code must be an object');
      else {
        for (const key of Object.keys(code)) if (!['host', 'client'].includes(key)) issues.push(`unexpected composition.code field: ${key}`);
        const hostIssue = boundedString(code.host, 'plan.composition.code.host', MAX_HOST_CODE_BYTES);
        issue({ issues }, hostIssue);
        if (code.client !== undefined) issue({ issues }, boundedString(code.client, 'plan.composition.code.client', MAX_HOST_CODE_BYTES));
      }
    }
    const verification = plan.verification;
    if (!isRecord(verification)) issues.push('plan.verification must be an object');
    else {
      for (const key of Object.keys(verification)) if (!['targetTool', 'observations', 'samples'].includes(key)) issues.push(`unexpected verification field: ${key}`);
      if (typeof verification.targetTool !== 'string' || !TOOL_NAME_PATTERN.test(verification.targetTool)) issues.push('plan.verification.targetTool is invalid');
      if (!Number.isInteger(verification.observations) || verification.observations < 1 || verification.observations > MAX_OBSERVATIONS) {
        issues.push(`plan.verification.observations must be an integer from 1 through ${MAX_OBSERVATIONS}`);
      }
      if (!Array.isArray(verification.samples) || verification.samples.length === 0 || verification.samples.length > MAX_SAMPLES) {
        issues.push(`plan.verification.samples must contain 1 through ${MAX_SAMPLES} samples`);
      } else {
        verification.samples.forEach((sample, index) => {
          const at = `plan.verification.samples[${index}]`;
          if (!isRecord(sample)) { issues.push(`${at} must be an object`); return; }
          for (const key of Object.keys(sample)) if (!['label', 'tool', 'arguments', 'expected'].includes(key)) issues.push(`${at} has unexpected field: ${key}`);
          issue({ issues }, boundedString(sample.label, `${at}.label`, 200));
          if (typeof sample.tool !== 'string' || !TOOL_NAME_PATTERN.test(sample.tool)) issues.push(`${at}.tool is invalid`);
          if (!isLosslessJson(sample.arguments ?? {})) issues.push(`${at}.arguments must be lossless JSON`);
          if (!Object.hasOwn(sample, 'expected')) issues.push(`${at}.expected is required`);
          else if (!isLosslessJson(sample.expected)) issues.push(`${at}.expected must be lossless JSON`);
        });
      }
    }
    if (plan.requestedTargetProfiles !== undefined) {
      const targets = plan.requestedTargetProfiles;
      if (!Array.isArray(targets) || targets.length === 0 || targets.length > PROFILE_NAMES.length
        || targets.some((target) => !PROFILE_NAMES.includes(target))
        || new Set(targets).size !== targets.length) {
        issues.push(`plan.requestedTargetProfiles must be unique values from ${PROFILE_NAMES.join(', ')}`);
      }
    }
  }
  return ok() ? { ok: true, value } : { ok: false, issues };
}

export function validateTaskState(value) {
  if (!isRecord(value)) return { ok: false, issues: ['state must be an object'] };
  const issues = [];
  if (value.schemaVersion !== SCHEMA_VERSION) issues.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (value.protocol !== PROTOCOL_VERSION) issues.push(`protocol must be ${PROTOCOL_VERSION}`);
  if (typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId)) issues.push('taskId is invalid');
  if (!PHASES.includes(value.phase)) issues.push(`phase must be one of ${PHASES.join(', ')}`);
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) issues.push('updatedAt must be an ISO timestamp');
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

/** Validate one bound owner approval. The identity fields are mandatory. */
export function validateApproval(value) {
  if (!isRecord(value)) return { ok: false, issues: ['approval must be an object'] };
  const issues = [];
  const allowed = ['schemaVersion', 'protocol', 'taskId', 'experimentId', 'sourceSha256', 'confirmation', 'confirmationText', 'targetProfiles', 'confirmedAt'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`unexpected field: ${key}`);
  if (value.schemaVersion !== SCHEMA_VERSION) issues.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (value.protocol !== PROTOCOL_VERSION) issues.push(`protocol must be ${PROTOCOL_VERSION}`);
  if (typeof value.taskId !== 'string' || !TASK_ID_PATTERN.test(value.taskId)) issues.push('taskId is invalid');
  if (typeof value.experimentId !== 'string' || !EXPERIMENT_ID_PATTERN.test(value.experimentId)) issues.push('experimentId is invalid');
  if (typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) issues.push('sourceSha256 must be 64 lowercase hex characters');
  if (value.confirmation !== true) issues.push('confirmation must be true');
  issue({ issues }, boundedString(value.confirmationText, 'confirmationText', 2000));
  if (!Array.isArray(value.targetProfiles) || value.targetProfiles.length > PROFILE_NAMES.length
    || value.targetProfiles.some((target) => !PROFILE_NAMES.includes(target))
    || new Set(value.targetProfiles).size !== value.targetProfiles.length) {
    issues.push(`targetProfiles must be unique values from ${PROFILE_NAMES.join(', ')}`);
  }
  if (typeof value.confirmedAt !== 'string' || Number.isNaN(Date.parse(value.confirmedAt))) issues.push('confirmedAt must be an ISO timestamp');
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

/** The initial state a host writes before it starts executing a task. */
export function createTaskState({ taskId, now = new Date().toISOString(), host = null }) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) throw new Error('createTaskState requires a valid taskId');
  return {
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL_VERSION,
    taskId,
    phase: 'accepted',
    createdAt: now,
    updatedAt: now,
    host,
    attempt: 1,
    experimentId: null,
    candidateSourceSha256: null,
    kernelSourceSha256: null,
    approval: null,
    gates: null,
    decision: null,
    publication: null,
    result: null,
    error: null,
    revert: null,
  };
}

/** Return a new state with the transition applied, or throw on an illegal edge. */
export function transitionTaskState(state, phase, patch = {}, now = new Date().toISOString()) {
  if (!isRecord(state) || !PHASES.includes(state.phase)) throw new Error('transitionTaskState requires a valid state');
  if (!PHASES.includes(phase)) throw new Error(`unknown phase: ${phase}`);
  if (!canTransition(state.phase, phase)) throw new Error(`illegal task phase transition: ${state.phase} -> ${phase}`);
  return { ...state, ...patch, phase, updatedAt: now };
}

/** Bound, serializable view the ACP client returns to the model. */
export function projectTaskState(state) {
  if (!isRecord(state)) return null;
  const result = isRecord(state.result) ? state.result : null;
  const error = isRecord(state.error) ? state.error : null;
  const approval = isRecord(state.approval) ? state.approval : null;
  const publication = isRecord(state.publication) ? state.publication : null;
  const gates = isRecord(state.gates) ? state.gates : null;
  const decision = isRecord(state.decision) ? state.decision : null;
  const revert = isRecord(state.revert) ? state.revert : null;
  return {
    taskId: state.taskId,
    phase: state.phase,
    terminal: isTerminalPhase(state.phase),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    experimentId: state.experimentId ?? null,
    candidateSourceSha256: state.candidateSourceSha256 ?? null,
    kernelSourceSha256: state.kernelSourceSha256 ?? null,
    gates: gates === null ? null : Object.fromEntries(Object.entries(gates).filter(([, value]) => typeof value === 'boolean')),
    decision: decision === null ? null : {
      kind: typeof decision.kind === 'string' ? decision.kind : null,
      eligible: typeof decision.eligible === 'boolean' ? decision.eligible : null,
      reasons: Array.isArray(decision.reasons) ? decision.reasons.filter((row) => typeof row === 'string').slice(0, 8) : [],
    },
    approval: approval === null ? null : {
      experimentId: approval.experimentId ?? null,
      sourceSha256: approval.sourceSha256 ?? null,
      targetProfiles: Array.isArray(approval.targetProfiles) ? [...approval.targetProfiles] : [],
      confirmedAt: approval.confirmedAt ?? null,
    },
    publication: publication === null ? null : {
      id: publication.id ?? null,
      pluginName: publication.pluginName ?? null,
      status: publication.status ?? null,
      sourceSha256: publication.sourceSha256 ?? null,
      approvedProfiles: Array.isArray(publication.approvedProfiles) ? [...publication.approvedProfiles] : [],
    },
    result: result === null ? null : {
      summary: typeof result.summary === 'string' ? result.summary : null,
      stable: result.stable === true,
      observations: Number.isInteger(result.observations) ? result.observations : null,
    },
    revert: revert === null ? null : {
      ok: revert.ok === true,
      status: typeof revert.status === 'string' ? revert.status : null,
    },
    error: error === null ? null : {
      code: typeof error.code === 'string' ? error.code : null,
      message: typeof error.message === 'string' ? error.message.slice(0, 500) : null,
    },
  };
}

/** Resolve the ready document of a live host; null when absent or malformed. */
export async function readReady(dshHome) {
  const value = await readJson(taskChannelPaths(dshHome).ready);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || value.protocol !== PROTOCOL_VERSION) return null;
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.instanceId !== 'string' || value.instanceId.length === 0) return null;
  return value;
}

/** Same-machine liveness proof used by the client. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Atomic, durable JSON write: sibling temp file, fsync, rename, fsync directory. */
export async function writeJson(file, value, { mode = 0o600 } = {}) {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = await fsp.open(temporary, 'wx', mode);
  try {
    await descriptor.writeFile(bytes, 'utf8');
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await fsp.rename(temporary, file);
  if (process.platform !== 'win32') {
    const handle = await fsp.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

/** List the JSON documents of one channel directory, sorted by name. */
export async function listJsonFiles(directory) {
  try {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => path.join(directory, entry.name)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Remove a file if it exists; never follows a symlink outside the channel. */
export async function removeFile(file) {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** True when the file is a regular file (not a symlink or directory). */
export async function isRegularFile(file) {
  try {
    return (await fsp.lstat(file)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
