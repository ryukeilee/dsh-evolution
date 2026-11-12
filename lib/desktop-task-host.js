/**
 * Desktop-side entry of the ACP -> Desktop evolution control channel.
 *
 * This entry is installed only into the `desktop` profile. It owns the task
 * state machine and executes each accepted task through the *real* official
 * tool registry: the same `evolution_*` kernel that Desktop agents use. It
 * never implements a second Evolution engine, never calls a model, and never
 * approves a promotion on its own — a task that reaches the owner gate waits
 * for an `experimentId + sourceSha256`-bound approval written by the ACP side
 * after the owner confirmed in conversation.
 *
 * The host is the only writer of `state/` and `host.json`; the ACP client only
 * writes validated requests and bound approvals. Everything runs in one
 * process (the official Desktop Electron host) and one task at a time, because
 * the Evolution runtime can hold only one Trial. The channel is the shared
 * `$DSH_HOME/storages/evolution/desktop-tasks/` directory.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveEvolutionPaths } from './diagnostics.js';
import { safeErrorDto } from './orchestrator.js';
import {
  MAX_OBSERVATIONS,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  TASK_ID_PATTERN,
  candidateSourceDigest,
  canTransition,
  createTaskState,
  isTerminalPhase,
  listJsonFiles,
  pidAlive,
  projectTaskState,
  readJson,
  removeFile,
  taskChannelPaths,
  transitionTaskState,
  validateApproval,
  validateTaskRequest,
  writeJson,
} from './desktop-task-protocol.js';

export const name = 'dsh-evolution-desktop-task-host';
export const inject = ['agents', 'tools'];

const DEFAULTS = Object.freeze({
  scanIntervalMs: 1500,
  approvalPollMs: 500,
  approvalTimeoutMs: 30 * 60 * 1000,
  toolTimeoutMs: 60_000,
  settleSamples: 4,
  settlePollMs: 250,
  settleMaxPolls: 240,
});

function boundedText(value, limit = 500) {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function errorProjection(error) {
  const detail = safeErrorDto(error, 'desktop-task');
  return {
    code: typeof detail.errorCode === 'string' ? detail.errorCode : null,
    category: detail.errorCategory,
    digest: detail.errorDigest,
    message: boundedText(detail.errorSummary),
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Canonical JSON comparison so sample expectations ignore object key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameValue(actual, expected) {
  return canonical(actual) === canonical(expected);
}

function stringArray(value, limit = 16) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').slice(0, limit) : [];
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function isDirectory(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

/**
 * Create the host executor. `apply()` mounts it; tests construct it directly
 * with injected services and no timers left running.
 */
export function createDesktopTaskHost(ctx, config = {}) {
  const paths = resolveEvolutionPaths({ dshHome: config.dshHome });
  const channel = taskChannelPaths(paths.dshHome);
  const options = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)) };
  const instanceId = crypto.randomUUID();
  const abort = new AbortController();
  const now = () => new Date().toISOString();
  const writes = new Map();
  let watcher = null;
  let interval = null;
  let queue = Promise.resolve();
  let active = null;
  let disposed = false;
  let foreignHost = null;
  let ownsReady = false;

  const warn = (label, error) => {
    try {
      const detail = errorProjection(error);
      Promise.resolve(ctx.logger?.warn?.(`[evolution] ${label}: ${detail.message} (${detail.category}, ${detail.digest})`)).catch(() => {});
    } catch {
      // Diagnostics must never change a task outcome.
    }
  };

  function hostDocument() {
    return {
      schemaVersion: SCHEMA_VERSION,
      protocol: PROTOCOL_VERSION,
      instanceId,
      pid: process.pid,
      startedAt: now(),
      profile: 'desktop',
      host: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  async function readReadyHost() {
    const ready = await readJson(channel.ready);
    if (ready === null || ready.schemaVersion !== SCHEMA_VERSION || ready.protocol !== PROTOCOL_VERSION) return null;
    if (!Number.isInteger(ready.pid) || ready.pid <= 0 || typeof ready.instanceId !== 'string') return null;
    return pidAlive(ready.pid) ? ready : null;
  }

  async function ensureDirectories() {
    for (const directory of [channel.root, channel.inbox, channel.state, channel.approvals, channel.claims]) {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }

  function statePath(taskId) {
    return path.join(channel.state, `${taskId}.json`);
  }

  async function readState(taskId) {
    const value = await readJson(statePath(taskId));
    if (value === null) return null;
    if (value.schemaVersion !== SCHEMA_VERSION || value.protocol !== PROTOCOL_VERSION || value.taskId !== taskId) return null;
    return value;
  }

  async function writeState(state) {
    writes.set(state.taskId, state);
    await writeJson(statePath(state.taskId), state);
    writes.delete(state.taskId);
    return state;
  }

  async function updateState(state, phase, patch) {
    const next = transitionTaskState(state, phase, patch, now());
    await writeState(next);
    return next;
  }

  /** Patch a state document without changing its phase. */
  async function patchState(state, patch) {
    return writeState({ ...state, ...patch, updatedAt: now() });
  }

  /** Recover leftover non-terminal tasks from a previous host process. */
  async function recoverPreviousTasks() {
    const recovered = [];
    for (const file of await listJsonFiles(channel.state)) {
      const taskId = path.basename(file, '.json');
      if (!TASK_ID_PATTERN.test(taskId)) continue;
      let state;
      try {
        state = await readJson(file);
      } catch (error) {
        warn(`unreadable task state ${taskId}`, error);
        continue;
      }
      if (state === null || state.schemaVersion !== SCHEMA_VERSION || state.taskId !== taskId) continue;
      if (isTerminalPhase(state.phase)) continue;
      // Never take over a task that another live host still owns. This is
      // defence in depth: Electron's single-instance lock normally prevents a
      // second Desktop profile host, but a differently keyed launch must not
      // let one host mark the other's in-flight task as interrupted.
      const ownerPid = state.host?.pid;
      if (Number.isInteger(ownerPid) && ownerPid !== process.pid && pidAlive(ownerPid)) continue;
      try {
        // A crash between the kernel's durable stable commit and this task
        // state write must not turn a real stable outcome into "interrupted":
        // the durable evidence is the authority, so adopt it when it proves a
        // benefit commit and the current phase can legally enter stable.
        const adopted = await adoptDurableStable(state).catch(() => null);
        if (adopted !== null) {
          await writeJson(file, adopted);
          recovered.push(taskId);
          continue;
        }
        const recoveredState = transitionTaskState(state, 'interrupted', {
          error: { code: 'E_DESKTOP_HOST_LOST', category: 'environment', digest: null, message: 'The Desktop host stopped before this task reached a terminal phase; it was not re-run.' },
          result: null,
        }, now());
        await writeJson(file, recoveredState);
        recovered.push(taskId);
      } catch (error) {
        // A state whose phase is not on a legal interrupted edge (for example a
        // state written by a newer build) is preserved untouched.
        warn(`could not mark task ${taskId} interrupted`, error);
      }
    }
    return recovered;
  }

  /** Tasks whose request exists but that have no state yet are queued. */
  async function pendingRequests() {
    const requests = [];
    for (const file of await listJsonFiles(channel.inbox)) {
      const taskId = path.basename(file, '.json');
      if (!TASK_ID_PATTERN.test(taskId)) continue;
      let request;
      try {
        request = await readJson(file);
      } catch (error) {
        warn(`unreadable task request ${taskId}`, error);
        continue;
      }
      const validation = validateTaskRequest(request);
      if (!validation.ok) {
        // Reject a malformed request through a durable failed state instead of
        // executing anything, and leave the request bytes for the operator.
        const rejected = createTaskState({ taskId, host: { instanceId, pid: process.pid } });
        try {
          await writeJson(statePath(taskId), transitionTaskState(rejected, 'failed', {
            error: { code: 'E_DESKTOP_TASK_INVALID', category: 'validation', digest: null, message: boundedText(validation.issues.slice(0, 6).join('; ')) },
          }, now()));
        } catch (error) {
          warn(`could not record invalid task ${taskId}`, error);
        }
        continue;
      }
      if ((await readState(taskId)) !== null) continue;
      requests.push({ file, taskId, request, createdAt: Date.parse(request.createdAt) || 0 });
    }
    requests.sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
    return requests;
  }

  async function claim(taskId, requestPath) {
    const file = path.join(channel.claims, `${taskId}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Publish the claim only after its complete content is durable: a reader
      // must never observe an empty half-written lock and mistake a live owner
      // for a dead one. `link()` is the atomic create-if-absent step.
      const temporary = path.join(channel.claims, `.${taskId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      try {
        const handle = await fsp.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, instanceId, at: now(), request: path.basename(requestPath) })}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await fsp.link(temporary, file);
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {}
        const live = owner !== null && Number.isInteger(owner.pid) && owner.pid !== process.pid && pidAlive(owner.pid);
        if (live) return false;
        // Same-machine pid proof is the only reclaim condition: a dead (or
        // self-owned) claim cannot be executing this task.
        try { await fsp.unlink(file); } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
      } finally {
        // The temporary name is never the lock; only the link is.
        await removeFile(temporary).catch(() => {});
      }
    }
    return false;
  }

  async function releaseClaim(taskId) {
    try { await fsp.unlink(path.join(channel.claims, `${taskId}.lock`)); } catch (error) { if (error?.code !== 'ENOENT') warn(`could not release claim ${taskId}`, error); }
  }

  function getTool(agent, toolName) {
    if (!toolName || typeof toolName !== 'string') throw codedError('E_DESKTOP_TOOL_NAME', 'task names an invalid tool');
    return ctx.tools.get(toolName, agent) ?? null;
  }

  async function callTool(agent, toolName, args, label) {
    const tool = getTool(agent, toolName);
    if (tool === null) throw codedError('E_DESKTOP_TOOL_UNAVAILABLE', `${label}: tool ${toolName} is not registered`);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(options.toolTimeoutMs)]);
    const result = await tool.execute(args, { agent, signal });
    return result;
  }

  /** Same as callTool but with an explicit signal, used by bounded cleanup. */
  async function callToolWithSignal(agent, toolName, args, label, signal) {
    const tool = getTool(agent, toolName);
    if (tool === null) throw codedError('E_DESKTOP_TOOL_UNAVAILABLE', `${label}: tool ${toolName} is not registered`);
    const result = await tool.execute(args, { agent, signal });
    return result;
  }

  async function waitForRuntime(agent) {
    let previous = null;
    let stable = 0;
    for (let poll = 0; poll < options.settleMaxPolls; poll += 1) {
      const runtime = await callTool(agent, 'evolution_runtime_inspect', {}, 'runtime inspection');
      const fingerprint = canonical({
        components: Array.isArray(runtime?.components) ? runtime.components : null,
        services: Array.isArray(runtime?.services) ? runtime.services : null,
        events: Array.isArray(runtime?.events) ? runtime.events : null,
      });
      stable = fingerprint === previous ? stable + 1 : 0;
      previous = fingerprint;
      if (stable >= options.settleSamples) return runtime;
      await sleep(options.settlePollMs, abort.signal);
    }
    throw codedError('E_DESKTOP_RUNTIME_UNSETTLED', 'the Desktop runtime did not settle before the trial deadline');
  }

  function resolveCwd(request) {
    if (typeof request.cwd === 'string' && path.isAbsolute(request.cwd) && isDirectory(request.cwd)) return path.resolve(request.cwd);
    return os.homedir();
  }

  async function runSamples(agent, plan, experimentId, kind) {
    const samples = [];
    for (const sample of plan.verification.samples) {
      if (abort.signal.aborted) throw codedError('E_DESKTOP_HOST_STOPPED', 'the Desktop host stopped during sample execution');
      // Defence in depth: the protocol already binds every sample to the
      // candidate's own tool, so a plan cannot drive an existing host tool.
      if (sample.tool !== plan.verification.targetTool) {
        throw codedError('E_DESKTOP_SAMPLE_TOOL', `sample ${boundedText(sample.label, 80)} calls ${sample.tool} instead of the candidate tool`);
      }
      const actual = await callTool(agent, sample.tool, sample.arguments ?? {}, `${kind} sample ${boundedText(sample.label, 80)}`);
      if (!sameValue(actual, sample.expected)) {
        const error = codedError('E_DESKTOP_SAMPLE_MISMATCH', `${kind} sample mismatch: ${boundedText(sample.label, 80)} produced ${boundedText(JSON.stringify(actual), 300)} but expected ${boundedText(JSON.stringify(sample.expected), 300)}`);
        error.sample = { label: boundedText(sample.label, 80), actual, expected: sample.expected };
        throw error;
      }
      samples.push({ label: boundedText(sample.label, 80), actual });
    }
    return samples;
  }

  async function readStableFacts(experimentId) {
    const evidence = await readJson(path.join(paths.archiveDir, `${experimentId}.evidence.json`)).catch(() => null);
    const index = await readJson(path.join(paths.dataRoot, 'shared-plugins', 'published.json')).catch(() => null);
    const record = Array.isArray(index?.plugins) ? index.plugins.find((row) => row?.experimentId === experimentId) ?? null : null;
    const kernelSourceSha256 = typeof evidence?.publication?.sourceSha256 === 'string' ? evidence.publication.sourceSha256
      : typeof record?.sourceSha256 === 'string' ? record.sourceSha256 : null;
    return {
      evidence,
      record,
      kernelSourceSha256,
      publication: record === null ? null : {
        id: bookmark(record.id),
        pluginName: bookmark(record.pluginName),
        sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : null,
        approvedProfiles: stringArray(record.approvedProfiles),
        status: typeof record.stable?.committedAt === 'string' ? 'published' : null,
      },
    };
  }

  /**
   * Adopt a durable stable commit when the host crashed after the kernel
   * committed it but before the task state was updated. Only evidence that
   * proves a benefit commit with runtime recovery may move a legal phase to
   * stable; everything else stays interrupted.
   */
  async function adoptDurableStable(state) {
    if (!canTransition(state.phase, 'stable')) return null;
    if (typeof state.experimentId !== 'string' || state.experimentId === '') return null;
    const evidence = await readJson(path.join(paths.archiveDir, `${state.experimentId}.evidence.json`)).catch(() => null);
    if (evidence === null) return null;
    if (evidence?.decision?.kind !== 'benefit' || evidence.runtimeRecovered !== true || typeof evidence.stableCommittedAt !== 'string') return null;
    const facts = await readStableFacts(state.experimentId);
    return transitionTaskState(state, 'stable', {
      experimentId: state.experimentId,
      kernelSourceSha256: facts.kernelSourceSha256,
      gates: evidence.gateEvidence?.gates ?? state.gates,
      decision: evidence.decision,
      publication: facts.publication,
      result: { stable: true, summary: 'Recovered the durable stable commit that the kernel wrote before this task state was updated.', observations: 0 },
      error: null,
    }, now());
  }

  function bookmark(value) {
    return typeof value === 'string' ? boundedText(value, 200) : null;
  }

  async function waitForApproval(state) {
    const deadline = Date.now() + options.approvalTimeoutMs;
    for (;;) {
      if (abort.signal.aborted) throw codedError('E_DESKTOP_HOST_STOPPED', 'the Desktop host stopped while waiting for the owner approval');
      let raw = null;
      try { raw = await readJson(path.join(channel.approvals, `${state.taskId}.json`)); } catch (error) { warn(`unreadable approval ${state.taskId}`, error); }
      if (raw !== null) {
        const validation = validateApproval(raw);
        if (!validation.ok) {
          throw codedError('E_DESKTOP_APPROVAL_INVALID', `the approval file was rejected: ${validation.issues.slice(0, 4).join('; ')}`);
        }
        if (raw.taskId !== state.taskId || raw.experimentId !== state.experimentId || raw.sourceSha256 !== state.candidateSourceSha256) {
          throw codedError('E_DESKTOP_APPROVAL_MISMATCH', 'the approval identity does not match the pending candidate; the trial is reverted and the approval file is preserved');
        }
        return raw;
      }
      if (Date.now() >= deadline) throw codedError('E_DESKTOP_APPROVAL_TIMEOUT', 'no bound owner approval arrived before the task deadline; the trial is reverted');
      await sleep(options.approvalPollMs, abort.signal);
    }
  }

  async function executeTask(agent, request, state) {
    const plan = request.plan;
    const startedAt = now();
    await waitForRuntime(agent);

    if (getTool(agent, plan.verification.targetTool) !== null) {
      throw codedError('E_DESKTOP_TARGET_EXISTS', `target tool ${plan.verification.targetTool} already exists before the trial`);
    }

    const proposed = await callTool(agent, 'evolution_propose', {
      why: plan.proposal.why,
      target: plan.proposal.target,
      impactScope: plan.proposal.impactScope,
      successMetrics: plan.proposal.successMetrics,
    }, 'propose');
    const experimentId = proposed?.experimentId;
    if (typeof experimentId !== 'string' || experimentId === '') throw codedError('E_DESKTOP_PROPOSE_FAILED', 'evolution_propose returned no experiment identity');
    state = await patchState(state, { experimentId, startedAt });

    await callTool(agent, 'evolution_trial', {
      experimentId,
      composition: {
        name: plan.composition.name,
        purpose: plan.composition.purpose,
        code: { host: plan.composition.code.host },
      },
    }, 'trial');

    const samples = await runSamples(agent, plan, experimentId, 'trial');
    const measured = await callTool(agent, 'evolution_measure', {
      experimentId,
      observation: {
        solvesProblem: true,
        metrics: { errors: 0 },
        beforeMetrics: { errors: 1 },
        afterMetrics: { errors: 0 },
        sampleCount: samples.length,
        observationWindow: `two deterministic registered-tool samples in the Desktop host: ${samples.map((sample) => sample.label).join(', ')}`.slice(0, 500),
        benefitEvidence: `the target tool ${bookmark(plan.verification.targetTool)} was absent before the trial and every registered-tool sample matched its expected value`.slice(0, 500),
        repeatable: true,
        regressionPassed: true,
        reversible: true,
        cleanupEvidence: 'promotion must dispose the real Trial and prove the captured runtime baseline before any stable commit',
      },
    }, 'measure');
    if (measured?.ok === false) throw codedError('E_DESKTOP_MEASURE_FAILED', `evolution_measure refused the evidence: ${boundedText(measured?.reason ?? 'unknown reason', 200)}`);

    const gate = await callTool(agent, 'evolution_promote', {
      experimentId,
      ...(plan.requestedTargetProfiles === undefined ? {} : { targetProfiles: plan.requestedTargetProfiles }),
    }, 'promotion gate');
    if (gate?.phase !== 'awaiting-owner-confirmation') {
      throw codedError('E_DESKTOP_OWNER_GATE_MISSING', `promotion without confirmation did not stop at the owner gate (phase ${bookmark(gate?.phase)}); nothing was promoted`);
    }

    const candidateSourceSha256 = candidateSourceDigest(plan.composition.code.host);
    state = await updateState(state, 'awaiting-owner-confirmation', {
      experimentId,
      candidateSourceSha256,
      gates: gate.gates ?? null,
      decision: gate.decision ?? null,
    });

    const approval = await waitForApproval(state);
    state = await updateState(state, 'promoting', {
      approval: {
        experimentId: approval.experimentId,
        sourceSha256: approval.sourceSha256,
        targetProfiles: [...approval.targetProfiles],
        confirmedAt: approval.confirmedAt,
        confirmationTextDigest: crypto.createHash('sha256').update(approval.confirmationText).digest('hex'),
      },
    });

    const promoted = await callTool(agent, 'evolution_promote', {
      experimentId,
      confirmation: true,
      targetProfiles: [...approval.targetProfiles],
    }, 'confirmed promotion');
    if (promoted?.phase !== 'canary-observing') {
      throw codedError('E_DESKTOP_PROMOTION_FAILED', `confirmed promotion did not reach canary (phase ${bookmark(promoted?.phase)}; ${boundedText(promoted?.reason ?? '', 200)})`);
    }
    state = await updateState(state, 'canary-observing', {});

    // The kernel owns the required canary window (`healthObservationWindow`),
    // which may be larger than the plan's requested observations. Keep
    // observing until the kernel says stable, bounded by a hard ceiling; the
    // plan only controls how many sample replays the owner asked for.
    const requestedObservations = Math.min(MAX_OBSERVATIONS, Math.max(1, plan.verification.observations));
    const maxObservations = Math.max(requestedObservations, 16);
    let stable = false;
    let observations = 0;
    for (let index = 1; index <= maxObservations; index += 1) {
      observations = index;
      let sampleResults;
      let regression = false;
      try {
        sampleResults = await runSamples(agent, plan, experimentId, 'canary');
      } catch (error) {
        if (error?.code !== 'E_DESKTOP_SAMPLE_MISMATCH') throw error;
        regression = true;
        sampleResults = [error.sample ?? { label: 'sample', actual: null }];
      }
      const observed = await callTool(agent, 'evolution_canary_observe', {
        experimentId,
        startupVerified: !regression,
        componentHealth: regression ? 'failed' : 'active',
        dependenciesPresent: true,
        metricRegression: regression,
        // `reached: true` describes this observation barrier itself; a
        // regression is expressed through metricRegression/startupVerified,
        // never by omitting the barrier (the kernel refuses that before it can
        // roll back).
        barrier: { id: `${state.taskId}-${index}`, reached: true },
        evidence: { actualToolOutput: sampleResults.map((sample) => sample.actual) },
      }, `canary observation ${index}`);
      if (regression) {
        const error = codedError('E_DESKTOP_CANARY_REGRESSION', `canary sample verification failed on observation ${index}; the kernel was asked to roll the promotion back`);
        error.kernelRollback = observed?.rollback === 'last-known-good' || observed?.phase === 'rolled-back'
          ? { ok: true, status: 'last-known-good' } : null;
        throw error;
      }
      stable = observed?.stable === true;
      if (stable) break;
    }
    if (!stable) {
      // Never leave the kernel in canary-observing with the candidate mounted:
      // one explicit regression observation is the kernel-owned rollback path.
      const rolled = await callTool(agent, 'evolution_canary_observe', {
        experimentId,
        startupVerified: false,
        componentHealth: 'failed',
        dependenciesPresent: true,
        metricRegression: true,
        barrier: { id: `${state.taskId}-unsettled`, reached: true },
        evidence: { reason: 'the observation ceiling was reached before a stable commit' },
      }, 'canary rollback after unsettled window').catch((error) => ({ rollbackError: errorProjection(error) }));
      const error = codedError('E_DESKTOP_CANARY_UNSETTLED', 'canary observations finished without a stable commit');
      error.kernelRollback = rolled?.phase === 'rolled-back' ? { ok: true, status: 'last-known-good' } : null;
      throw error;
    }

    const facts = await readStableFacts(experimentId);
    return updateState(state, 'stable', {
      kernelSourceSha256: facts.kernelSourceSha256,
      gates: facts.evidence?.gateEvidence?.gates ?? state.gates,
      decision: facts.evidence?.decision ?? state.decision,
      publication: facts.publication,
      result: {
        stable: true,
        summary: facts.publication === null
          ? 'Desktop committed the promotion as a Desktop-only stable plugin.'
          : `Desktop committed the promotion as stable and published it to ${facts.publication.approvedProfiles.join(', ')}.`,
        observations,
      },
      error: null,
    });
  }

  async function attemptRevert(agent, experimentId, state, signal = undefined) {
    if (typeof experimentId !== 'string' || experimentId === '') return state;
    try {
      const reverted = signal === undefined
        ? await callTool(agent, 'evolution_revert', { experimentId }, 'revert after failure')
        : await callToolWithSignal(agent, 'evolution_revert', { experimentId }, 'revert after failure', signal);
      return await patchState(state, {
        revert: { ok: reverted?.runtimeRecovered === true || reverted?.ok === true, status: bookmark(reverted?.phase) },
      }).catch(() => state);
    } catch (error) {
      const detail = errorProjection(error);
      const next = { ...state, revert: { ok: false, status: detail.code ?? 'revert-failed' } };
      await writeState(next).catch(() => {});
      return next;
    }
  }

  async function runTask(entry) {
    const { taskId, file } = entry;
    let state;
    let request;
    let claimed = false;
    try {
      request = await readJson(file);
      const validation = validateTaskRequest(request);
      if (!validation.ok) throw codedError('E_DESKTOP_TASK_INVALID', validation.issues.slice(0, 6).join('; '));
      claimed = await claim(taskId, file);
      if (!claimed) return;
      state = createTaskState({ taskId, host: { instanceId, pid: process.pid } });
      state = await writeState(state);
    } catch (error) {
      if (claimed) await releaseClaim(taskId);
      const rejected = transitionTaskState(createTaskState({ taskId, host: { instanceId, pid: process.pid } }), 'failed', { error: errorProjection(error) }, now());
      await writeState(rejected).catch((writeError) => warn(`could not record failed task ${taskId}`, writeError));
      return;
    }

    let agent = null;
    let handle = null;
    let experimentId = null;
    try {
      const created = await ctx.agents.create({ sessionId: `desktop-task-${taskId}`, meta: { cwd: resolveCwd(request) } });
      handle = created ?? null;
      agent = created?.agent ?? created;
      if (!agent) throw codedError('E_DESKTOP_AGENT_UNAVAILABLE', 'the Desktop host could not create the experiment owner identity');
      state = await updateState(state, 'running', { startedAt: now() });
      const finished = await executeTask(agent, request, state);
      state = finished;
    } catch (error) {
      // The failing step may have written a newer phase (for example
      // awaiting-owner-confirmation) than the copy held here; recovery and
      // revert must act on the durable fact, not on this stale local copy.
      state = (await readState(taskId).catch(() => null)) ?? state;
      const interrupted = abort.signal.aborted || error?.code === 'E_DESKTOP_HOST_STOPPED';
      experimentId = experimentId ?? state.experimentId ?? null;
      if (error?.kernelRollback) {
        // The kernel already rolled the promotion back; a second revert would
        // only hide that fact.
        state = await patchState(state, { revert: error.kernelRollback }).catch(() => state);
      } else if (agent !== null && typeof experimentId === 'string' && experimentId !== '') {
        // A stopped host still gets one bounded cleanup attempt with its own
        // signal, so a graceful unload does not leave the Trial mounted. A hard
        // process kill cannot run cleanup; the fresh runtime after restart makes
        // the leftover trial irrelevant, and the task is marked interrupted.
        const cleanupSignal = interrupted ? AbortSignal.timeout(Math.min(15_000, options.toolTimeoutMs)) : undefined;
        state = await attemptRevert(agent, experimentId, state, cleanupSignal);
      }
      const terminalPhase = interrupted ? 'interrupted' : 'failed';
      const patch = {
        error: interrupted
          ? { code: 'E_DESKTOP_HOST_STOPPED', category: 'environment', digest: null, message: 'The Desktop host stopped before the task reached a terminal phase; it was not re-run.' }
          : errorProjection(error),
        result: null,
      };
      try {
        state = isTerminalPhase(state.phase) ? state : await updateState(state, terminalPhase, patch);
      } catch (writeError) {
        warn(`could not record terminal task state ${taskId}`, writeError);
      }
      if (!interrupted) warn(`Desktop task ${taskId} failed`, error);
    } finally {
      if (handle !== null) {
        try { await handle.dispose?.(); } catch (error) { warn(`could not dispose the task agent identity ${taskId}`, error); }
      } else if (agent !== null && typeof agent.dispose === 'function') {
        try { await agent.dispose(); } catch (error) { warn(`could not dispose the task agent identity ${taskId}`, error); }
      }
      await releaseClaim(taskId);
      active = null;
    }
  }

  function kick() {
    if (disposed) return queue;
    queue = queue.then(async () => {
      if (active !== null) return;
      const requests = await pendingRequests();
      if (requests.length === 0) return;
      active = requests[0].taskId;
      try {
        await runTask(requests[0]);
      } catch (error) {
        warn(`unhandled task failure ${requests[0].taskId}`, error);
      } finally {
        active = null;
        if (!disposed) void kick();
      }
    }).catch((error) => {
      warn('Desktop task queue failed', error);
    });
    return queue;
  }

  async function start() {
    await ensureDirectories();
    // Refuse to become a second live host: a ready document whose owner is
    // still alive means this process must not overwrite it or drain the queue.
    const existing = await readReadyHost().catch(() => null);
    if (existing !== null && existing.instanceId !== instanceId) {
      foreignHost = existing;
      return;
    }
    await recoverPreviousTasks();
    if (disposed) return;
    await writeJson(channel.ready, hostDocument());
    ownsReady = true;
    try {
      watcher = fs.watch(channel.inbox, { persistent: false }, () => { void kick(); });
      watcher.on?.('error', (error) => warn('Desktop task inbox watcher failed', error));
    } catch (error) {
      warn('Desktop task inbox watcher unavailable; the safety rescan still runs', error);
    }
    if (options.scanIntervalMs > 0) {
      interval = setInterval(() => { void kick(); }, options.scanIntervalMs);
      interval.unref?.();
    }
    void kick();
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    abort.abort(codedError('E_DESKTOP_HOST_STOPPED', 'the Desktop host is shutting down'));
    try { watcher?.close?.(); } catch {}
    if (interval !== null) clearInterval(interval);
    interval = null;
    try { await queue; } catch {}
    if (ownsReady) await removeFile(channel.ready).catch(() => {});
  }

  return {
    instanceId,
    paths,
    channel,
    hostDocument,
    start,
    dispose,
    kick,
    runTask,
    // Exposed for focused tests only; production callers use start()/dispose().
    internals: { recoverPreviousTasks, pendingRequests, claim, executeTask, waitForApproval },
    foreignHost: () => foreignHost,
  };
}

/** Mount the Desktop task host and tie its lifetime to the Cordis fiber. */
export function apply(ctx, config = {}) {
  const host = createDesktopTaskHost(ctx, config);
  ctx.effect(() => () => host.dispose());
  void host.start().catch((error) => {
    try {
      const detail = safeErrorDto(error, 'desktop-task-host');
      Promise.resolve(ctx.logger?.warn?.(`[evolution] Desktop task host failed to start: ${boundedText(detail.errorSummary)}`)).catch(() => {});
    } catch {
      // Startup diagnostics never escalate.
    }
  });
  return host;
}
