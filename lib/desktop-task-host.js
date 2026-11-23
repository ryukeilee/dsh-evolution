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

import { resolveEvolutionPaths } from './evolution-paths.js';
import { safeErrorDto } from './error-boundary.js';
import { PTC_WRAPPED_VALUE, ptcDirectCallRefusal, ptcKernelCallProgram, ptcWrappedEnvelope } from './ptc-transport.js';
import { withVerificationCall } from './verification-call.js';
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

// A PTC agent preset exposes every non-run_code tool only from inside a
// run_code program. The kernel's own calls must use that official transport
// instead of treating the refusal as a failed task. The refusal rule, the
// sentinel and the envelope reader are shared with the probe's workload steps
// (lib/ptc-transport.js), so both call sites recognize the same executor.

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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  // One failed task may leave the kernel in `revert-failed` / a still-mounted
  // Trial. That runtime is unusable for later tasks, so the host keeps the
  // owner identity and retries the official revert until recovery is proven
  // instead of finalizing the task and disposing the only handle that can
  // retry it.
  let pendingCleanup = null;

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
    for (const directory of [channel.root, channel.inbox, channel.state, channel.approvals, channel.claims, channel.taskEvidence]) {
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
      // A second Host instance in this same process has a live pid, so the check
      // above cannot see it. Its task claim is the proof of ownership: claim()
      // writes it before the state and releases it only when the task settles,
      // so a live same-pid claim means another live instance is still running
      // this task.
      if (ownerPid === process.pid) {
        const claim = await readClaim(taskId);
        if (claim !== null && claim.instanceId !== instanceId
          && Number.isInteger(claim.pid) && pidAlive(claim.pid)) continue;
      }
      let claimed = false;
      try {
        // Take the task claim before deciding or writing. The previous owner
        // releases its claim only after its final state write, so a successful
        // claim proves no other live instance is mid-write; a live claim makes
        // us back off. This closes the read-then-overwrite window where a stale
        // "running" snapshot overwrote a newer "failed".
        claimed = await claim(taskId, path.join(channel.inbox, `${taskId}.json`));
        if (!claimed) continue;
        // Re-read under the claim: only the latest, still non-terminal state may
        // be recovered. A peer that finished while we were deciding has already
        // written its terminal phase and released the claim we now hold.
        const latest = await readJson(file).catch(() => null);
        if (latest === null || latest.schemaVersion !== SCHEMA_VERSION || latest.taskId !== taskId) continue;
        if (isTerminalPhase(latest.phase)) continue;
        // A crash between the kernel's durable stable commit and this task
        // state write must not turn a real stable outcome into "interrupted":
        // the durable evidence is the authority, so adopt it when it proves a
        // benefit commit and the current phase can legally enter stable.
        const adopted = await adoptDurableStable(latest).catch(() => null);
        if (adopted !== null) {
          await writeJson(file, adopted);
          recovered.push(taskId);
          continue;
        }
        const recoveredState = transitionTaskState(latest, 'interrupted', {
          error: { code: 'E_DESKTOP_HOST_LOST', category: 'environment', digest: null, message: 'The Desktop host stopped before this task reached a terminal phase; it was not re-run.' },
          result: null,
        }, now());
        await writeJson(file, recoveredState);
        recovered.push(taskId);
      } catch (error) {
        // A state whose phase is not on a legal interrupted edge (for example a
        // state written by a newer build) is preserved untouched.
        warn(`could not mark task ${taskId} interrupted`, error);
      } finally {
        if (claimed) await releaseClaim(taskId);
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
      // A task that already has a state is not pending, whatever the request
      // says. This check comes before any write: a scan must never overwrite the
      // terminal phase of a task another live host is finishing.
      if ((await readState(taskId)) !== null) continue;
      // Reading is only used to order the queue. Validation and identity checks
      // happen inside runTask, under the task claim, so a malformed request is
      // recorded once by its owner rather than by every scanning process.
      let createdAt = 0;
      try {
        const request = await readJson(file);
        createdAt = Date.parse(request?.createdAt) || 0;
      } catch (error) {
        // A malformed request is still pending; runTask will claim it and write
        // a durable failed state.
        warn(`unreadable task request ${taskId}`, error);
      }
      requests.push({ file, taskId, createdAt });
    }
    requests.sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
    return requests;
  }

  async function claim(taskId, requestPath) {
    await fsp.mkdir(channel.claims, { recursive: true, mode: 0o700 });
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
        // Another instance in this same process is still a live owner: its pid
        // is alive, so reclaiming on "same pid" alone let a second Host instance
        // unlink the first one's claim and write a failed state for the same
        // task. Only a dead pid, or our own instance's leftover claim, proves
        // that nothing is executing the task.
        const sameInstance = owner !== null && owner.instanceId === instanceId;
        const live = owner !== null && Number.isInteger(owner.pid)
          && pidAlive(owner.pid) && !sameInstance;
        if (live) return false;
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

  /** The claim record of one task, or null when there is none (or it is unreadable). */
  async function readClaim(taskId) {
    try {
      const claim = JSON.parse(await fsp.readFile(path.join(channel.claims, `${taskId}.lock`), 'utf8'));
      return claim && typeof claim === 'object' ? claim : null;
    } catch {
      return null;
    }
  }

  function getTool(agent, toolName) {
    if (!toolName || typeof toolName !== 'string') throw codedError('E_DESKTOP_TOOL_NAME', 'task names an invalid tool');
    return ctx.tools.get(toolName, agent) ?? null;
  }

  /**
   * Execute one tool call through the official tools pipeline when the host
   * provides it (`ctx.tools.execute`): the descriptor, argument validation,
   * pre-execute policy, monotonic guards, post-execute policies and canonical
   * output checks all run exactly as they do for an agent step. The direct
   * `definition.execute` fallback exists only for older hosts and unit tests.
   */
  async function callToolWithSignal(agent, toolName, args, label, signal) {
    const tool = getTool(agent, toolName);
    if (tool === null) throw codedError('E_DESKTOP_TOOL_UNAVAILABLE', `${label}: tool ${toolName} is not registered`);
    if (typeof ctx.tools.execute === 'function') {
      const callId = `desktop-task-${crypto.randomUUID()}`;
      const batch = await withVerificationCall(agent, callId, () => ctx.tools.execute({
        calls: [{ id: callId, name: toolName, arguments: JSON.stringify(args ?? {}) }],
        signal,
        agent,
        maxParallelToolCalls: 1,
      }));
      const settled = Array.isArray(batch?.results) ? batch.results.find((row) => row?.callId === callId) : undefined;
      if (settled === undefined) throw codedError('E_DESKTOP_TOOL_NO_RESULT', `${label}: the tools pipeline returned no result for ${toolName}`);
      if (settled.result?.isError === true) {
        const detail = settled.result.error;
        const message = boundedText(detail?.message ?? detail?.info?.message ?? 'tool error', 400);
        if (toolName !== 'run_code' && ptcDirectCallRefusal(settled.result, toolName) !== null) {
          return callToolThroughRunCode(agent, toolName, args, label, signal);
        }
        const error = codedError(detail?.info?.code ?? detail?.code ?? 'E_DESKTOP_TOOL_FAILED', `${label} refused: ${message}`);
        throw error;
      }
      return settled.result?.value;
    }
    return tool.execute(args, { agent, signal });
  }

  /**
   * Execute one kernel tool call through the official run_code transport.
   *
   * A PTC preset makes run_code the only directly callable tool; the transport
   * returns its own `{ logs, result? }` envelope, while the caller expects the
   * inner tool's value exactly as the direct pipeline returns it. The wrapper
   * program carries the value under one sentinel property so no tool payload
   * can be confused with that envelope.
   */
  async function callToolThroughRunCode(agent, toolName, args, label, signal) {
    const program = ptcKernelCallProgram(toolName, args);
    const callId = `desktop-task-${crypto.randomUUID()}`;
    const batch = await withVerificationCall(agent, callId, () => ctx.tools.execute({
      calls: [{
        id: callId,
        name: 'run_code',
        arguments: JSON.stringify({ code: program, description: `evolution desktop task: ${toolName}`.slice(0, 200) }),
      }],
      signal,
      agent,
      maxParallelToolCalls: 1,
    }));
    const settled = Array.isArray(batch?.results) ? batch.results.find((row) => row?.callId === callId) : undefined;
    if (settled === undefined) throw codedError('E_DESKTOP_TOOL_NO_RESULT', `${label}: the run_code transport returned no result for ${toolName}`);
    if (settled.result?.isError === true) {
      const detail = settled.result.error;
      throw codedError(detail?.info?.code ?? detail?.code ?? 'E_DESKTOP_TOOL_FAILED',
        `${label} refused through run_code: ${boundedText(detail?.message ?? detail?.info?.message ?? 'tool error', 400)}`);
    }
    const wrapped = ptcWrappedEnvelope(settled.result?.value);
    if (wrapped === null) {
      throw codedError('E_DESKTOP_TOOL_RESULT', `${label}: the run_code transport returned no wrapped value for ${toolName}`);
    }
    return wrapped[PTC_WRAPPED_VALUE];
  }

  async function callTool(agent, toolName, args, label) {
    return callToolWithSignal(agent, toolName, args, label, AbortSignal.any([abort.signal, AbortSignal.timeout(options.toolTimeoutMs)]));
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
    // A context-policy candidate has no tool of its own. Its samples array is
    // absent by contract, and running the loop over undefined would turn a
    // verified plan into a host crash.
    if (!Array.isArray(plan.verification.samples)) return samples;
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
    if (kind === 'canary' && plan.verification.workload) {
      for (const step of plan.verification.workload.steps) {
        const actual = await callTool(agent, step.candidateName ?? step.name, step.arguments, 'canary workload');
        let selected = actual;
        for (const key of step.resultPath ?? []) selected = selected !== null && typeof selected === 'object' && Object.hasOwn(selected, key) ? selected[key] : undefined;
        if (!sameValue(selected, step.expected)) throw codedError('E_DESKTOP_WORKLOAD_REGRESSION', 'the canary workload no longer meets its shared acceptance criterion');
      }
    }
    return samples;
  }

  /**
   * A context-policy candidate registers no tool, so samples cannot prove it is
   * active. The plan instead declares one deterministic call to an existing
   * read-only tool whose output the policy transforms. Running it after the
   * Trial mount and on every canary observation is what makes "the candidate
   * is installed" different from "the candidate actually takes effect".
   */
  async function runFunctionalCheck(agent, plan, label) {
    const check = plan.verification.functionalCheck;
    if (!isRecord(check)) return null;
    const actual = await callTool(agent, check.tool, check.arguments ?? {}, `${label} functional check`);
    let selected = actual;
    let present = actual !== undefined;
    for (const key of check.resultPath ?? []) {
      if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key)) {
        present = false;
        selected = undefined;
        break;
      }
      selected = selected[key];
    }
    if (selected === undefined) present = false;
    const canonical = JSON.stringify(selected) ?? '';
    return {
      label: boundedText(label, 80),
      tool: boundedText(check.tool, 120),
      // A missing field is not the same as an expected null: deleting the
      // field must not satisfy the check.
      present,
      matched: present && sameValue(selected, check.expected),
      resultSha256: crypto.createHash('sha256').update(canonical).digest('hex'),
      resultCharacters: canonical.length,
    };
  }

  /** The mounted candidate must produce the declared effect. */
  function requireFunctionalMatch(check, label) {
    if (check === null || check.matched === true) return;
    const error = codedError('E_DESKTOP_FUNCTIONAL_CHECK',
      `${label} functional check: ${boundedText(check.tool, 80)} did not transform the declared result; the candidate is not active`);
    error.functionalCheck = check;
    throw error;
  }

  /**
   * The same call must fail the declared effect before the Trial mounts the
   * candidate. Without this a check whose baseline already matches would let an
   * empty plugin pass both the Trial and every canary observation.
   */
  function requireFunctionalMismatch(check, label) {
    if (check === null || check.matched !== true) return;
    const error = codedError('E_DESKTOP_FUNCTIONAL_CHECK',
      `${label} functional check already matches before the candidate is mounted; it cannot prove that the candidate takes effect`);
    error.functionalCheck = check;
    throw error;
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
    const improvement = plan.proposal.improvement ?? 'tool';
    await waitForRuntime(agent);

    // A tool-form candidate must add a capability that does not exist yet. A
    // context-policy candidate has no target tool at all.
    if (improvement !== 'context-policy' && getTool(agent, plan.verification.targetTool) !== null) {
      throw codedError('E_DESKTOP_TARGET_EXISTS', `target tool ${plan.verification.targetTool} already exists before the trial`);
    }

    // Optional strategy/rootCause were authored by the ACP side and validated
    // by the shared protocol; they are forwarded unchanged and never
    // synthesized here (the kernel records them as the experiment's own
    // hypothesis and applicability identity).
    const proposed = await callTool(agent, 'evolution_propose', {
      why: plan.proposal.why,
      target: plan.proposal.target,
      impactScope: plan.proposal.impactScope,
      successMetrics: plan.proposal.successMetrics,
      ...(plan.proposal.strategy === undefined ? {} : { strategy: plan.proposal.strategy }),
      ...(plan.proposal.rootCause === undefined ? {} : { rootCause: plan.proposal.rootCause }),
      ...(improvement === 'tool' ? {} : { improvement }),
      // A paired workload is a workflow before/after, so the proposal must carry
      // the workflow model that activates the workflowBenefit promotion gate.
      // The caller's declaration is forwarded only when there is no workload:
      // an earlier second spread here silently overrode this one and let a
      // caller-supplied `kind: 'capability'` downgrade the gate on a real
      // workload experiment. There is no legitimate case for both.
      ...(plan.verification.workload
        ? { benefitModel: { kind: 'workflow' } }
        : plan.proposal.benefitModel === undefined ? {} : { benefitModel: plan.proposal.benefitModel }),
    }, 'propose');
    const experimentId = proposed?.experimentId;
    if (typeof experimentId !== 'string' || experimentId === '') throw codedError('E_DESKTOP_PROPOSE_FAILED', 'evolution_propose returned no experiment identity');
    state = await patchState(state, { experimentId, startedAt });

    // Capture the unmodified behavior first: a functional effect that already
    // holds before the candidate is mounted cannot attribute anything to it.
    const baselineFunctionalCheck = await runFunctionalCheck(agent, plan, 'baseline');
    if (baselineFunctionalCheck !== null) {
      requireFunctionalMismatch(baselineFunctionalCheck, 'baseline');
      state = await patchState(state, { functionalCheck: {
        ...(isRecord(state.functionalCheck) ? state.functionalCheck : {}),
        baseline: baselineFunctionalCheck,
      } });
    }

    if (plan.verification.workload) await callTool(agent, 'evolution_probe', {
      experimentId, phase: 'baseline', scenario: plan.verification.workload,
    }, 'workflow baseline');

    await callTool(agent, 'evolution_trial', {
      experimentId,
      composition: {
        name: plan.composition.name,
        purpose: plan.composition.purpose,
        code: { host: plan.composition.code.host },
      },
    }, 'trial');

    const samples = await runSamples(agent, plan, experimentId, 'trial');
    const trialFunctionalCheck = await runFunctionalCheck(agent, plan, 'trial');
    if (trialFunctionalCheck !== null) {
      requireFunctionalMatch(trialFunctionalCheck, 'trial');
      state = await patchState(state, { functionalCheck: {
        ...(isRecord(state.functionalCheck) ? state.functionalCheck : {}),
        trial: trialFunctionalCheck,
      } });
    }
    const workload = plan.verification.workload ? await callTool(agent, 'evolution_probe', {
      experimentId, phase: 'candidate', scenario: plan.verification.workload,
    }, 'workflow candidate') : null;
    if (workload) state = await patchState(state, { workload: {
      scenarioId: workload.scenarioId, scenarioDigest: workload.scenarioDigest, versions: workload.versions,
      comparison: workload.comparison,
    } });
    // Task-coupled evidence is produced before the task is delegated: the
    // acceptance harness runs the same natural task with and without this exact
    // candidate source and writes the artifact under the channel by taskId. The
    // host never accepts a path from the plan, only this derived name.
    let taskBenefit = null;
    if (plan.verification.task) {
      // The state's taskId is the verified filename identity, not the request
      // body: the evidence is looked up by the task this host is running.
      const file = path.join(channel.taskEvidence, `${state.taskId}.json`);
      try {
        taskBenefit = await readJson(file);
      } catch (error) {
        throw codedError('E_DESKTOP_TASK_EVIDENCE_INVALID', `the task evidence could not be read: ${boundedText(error?.message ?? 'unknown', 200)}`);
      }
      if (taskBenefit === null) {
        throw codedError('E_DESKTOP_TASK_EVIDENCE_MISSING',
          `no paired real-session evidence for task ${request.taskId}; a context-policy candidate cannot be measured from capability samples`);
      }
      // The plan declares *which* task this evidence belongs to. Without these
      // checks, a benefit measured on another task (or for another candidate
      // source) could be attributed to this one: the artifact is a file on a
      // shared channel, so the host must match it field by field.
      const declared = plan.verification.task;
      const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
      const mismatch = (label) => codedError('E_DESKTOP_TASK_EVIDENCE_MISMATCH',
        `the task evidence does not match the plan: ${label}`);
      if (taskBenefit.taskId !== state.taskId) throw mismatch('taskId');
      if (taskBenefit.candidateHostSha256 !== digest(plan.composition.code.host)) throw mismatch('candidate source');
      if (taskBenefit.task?.id !== declared.id) throw mismatch('task id');
      if (taskBenefit.task?.promptSha256 !== digest(declared.prompt)) throw mismatch('prompt');
      if (taskBenefit.task?.expectSha256 !== digest(declared.expect)) throw mismatch('expect');
      if (declared.runs !== undefined && (taskBenefit.runs?.baseline !== declared.runs || taskBenefit.runs?.candidate !== declared.runs)) {
        throw mismatch('declared run count');
      }
    }

    const measured = await callTool(agent, 'evolution_measure', {
      experimentId,
      taskId: state.taskId,
      observation: {
        // Capability samples prove only that the candidate tool returns the
        // values the plan declared. They do not measure a workflow before/after,
        // so the host must not claim one: this block used to hardcode
        // solvesProblem/before/after (1 error -> 0 errors), which made the
        // promotion gates read a benefit the host never measured.
        solvesProblem: false,
        evidenceKind: taskBenefit !== null ? 'task-coupled' : workload ? 'comparative-workload' : 'capability-self-test',
        metrics: { capabilitySamples: samples.length },
        sampleCount: samples.length,
        observationWindow: `capability samples only: ${samples.map((sample) => sample.label).join(', ')}`.slice(0, 500),
        benefitEvidence: `the candidate tool matched ${samples.length} deterministic samples; no workflow before/after was measured`.slice(0, 500),
        repeatable: false,
        regressionPassed: workload !== null,
        reversible: true,
        cleanupEvidence: 'promotion must dispose the real Trial and prove the captured runtime baseline before any stable commit',
        ...(taskBenefit === null ? {} : { taskBenefit }),
      },
    }, 'measure');
    if (measured?.ok === false) throw codedError('E_DESKTOP_MEASURE_FAILED', `evolution_measure refused the evidence: ${boundedText(measured?.reason ?? 'unknown reason', 200)}`);

    // A capability self-test is not a benefit claim. Stop before asking the owner
    // to approve evidence the promotion gate already rejects, and name the
    // missing gates instead of turning this into a generic task failure.
    if (measured?.gates && measured.gates.eligible === false) {
      // Only the gates that participate in eligibility; `runtimeRecovered` is
      // false at measure time by design and is not part of this evidence set.
      const gateKeys = ["realBenefit", "measuredEvidence", "repeatable", "regressionTest", "reversible", "cleanupEvidence", "noOrphans", "workflowBenefit", "taskBenefit"];
      const missing = gateKeys.filter((key) => Object.hasOwn(measured.gates, key) && measured.gates[key] !== true);
      state = await patchState(state, { gates: measured.gates, decision: measured.decision ?? null });
      throw codedError('E_DESKTOP_BENEFIT_UNPROVEN', `the measured evidence is not eligible (missing: ${missing.join(', ')}); nothing was promoted`);
    }

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
      let functionalCheck = null;
      let regression = false;
      try {
        sampleResults = await runSamples(agent, plan, experimentId, 'canary');
        functionalCheck = await runFunctionalCheck(agent, plan, `canary-${index}`);
        requireFunctionalMatch(functionalCheck, `canary-${index}`);
      } catch (error) {
        // Any canary verification failure — a wrong value, a missing tool, or
        // a throwing body — must travel through the kernel's own regression
        // observation. A generic revert cannot clean up a `canary-observing`
        // promotion, so leaving this path generic would keep the candidate
        // mounted in production.
        regression = true;
        functionalCheck = error?.functionalCheck ?? null;
        sampleResults = [error?.sample ?? { label: 'sample', actual: null, error: errorProjection(error) }];
      }
      if (functionalCheck !== null) {
        const checks = [...(Array.isArray(state.functionalCheck?.canary) ? state.functionalCheck.canary : []), functionalCheck];
        state = await patchState(state, { functionalCheck: {
          ...(isRecord(state.functionalCheck) ? state.functionalCheck : {}),
          canary: checks,
        } }).catch(() => state);
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
        evidence: {
          actualToolOutput: sampleResults.map((sample) => sample.actual),
          ...(functionalCheck === null ? {} : { functionalCheck }),
        },
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

  /**
   * Classify a kernel cleanup refusal. Three refusals are positive evidence
   * that the runtime is already free: the record was discarded after a proven
   * cleanup ("not known"), the experiment never reached a Trial (`is proposed;
   * Revert requires a Trial`), or the kernel already committed the rollback
   * (`is rolled-back`) and only its archive write failed. Every other state —
   * notably `canary-observing` — still owns a mounted candidate, so cleanup is
   * unproven and must keep retrying.
   */
  function classifyCleanupRefusal(message) {
    if (/is rolled-back/i.test(message)) return { proven: true, status: 'last-known-good' };
    if (/not known in this session|is not known|unknown experiment|is proposed; Revert requires a Trial/i.test(message)) {
      return { proven: true, status: 'experiment-discarded' };
    }
    return { proven: false, status: null };
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
      const classification = classifyCleanupRefusal(detail.message ?? '');
      const next = { ...state, revert: classification.proven
        ? { ok: true, status: classification.status }
        : { ok: false, status: detail.code ?? 'revert-failed' } };
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
      // Claim first: while another live host owns this task, this scan must not
      // write any state for it. The state, request and identity checks then run
      // under the claim, so a rejection and a concurrently started execution
      // cannot race on the same task file.
      claimed = await claim(taskId, file);
      if (!claimed) return;
      if ((await readState(taskId)) !== null) { await releaseClaim(taskId); return; }
      request = await readJson(file);
      const validation = validateTaskRequest(request);
      if (!validation.ok) throw codedError('E_DESKTOP_TASK_INVALID', validation.issues.slice(0, 6).join('; '));
      // The filename is the channel identity; the body must agree with it.
      if (request.taskId !== taskId) {
        throw codedError('E_DESKTOP_TASK_ID_MISMATCH', 'the request body taskId does not match the inbox filename');
      }
      state = createTaskState({ taskId, host: { instanceId, pid: process.pid } });
      state = await writeState(state);
    } catch (error) {
      if (claimed) {
        const rejected = transitionTaskState(createTaskState({ taskId, host: { instanceId, pid: process.pid } }), 'failed', { error: errorProjection(error) }, now());
        await writeState(rejected).catch((writeError) => warn(`could not record failed task ${taskId}`, writeError));
        await releaseClaim(taskId);
      }
      return;
    }

    let agent = null;
    let handle = null;
    let experimentId = null;
    try {
      // Desktop's official tools live in the selected preset, rather than the
      // root composition. Mount that same preset before publishing this owner,
      // just as the official session controller does; never copy tool plugins.
      // A workload replays preset tools (read/glob/...); a context-policy
      // functional check does the same. Either way the official preset must be
      // mounted on this agent, or the check cannot see the tool it verifies.
      const needsPreset = Boolean(request.plan.verification.workload || request.plan.verification.functionalCheck);
      const presets = needsPreset ? ctx.get?.('agentPresets') : null;
      const preset = presets ? await presets.resolve() : null;
      const created = await ctx.agents.create({ sessionId: `desktop-task-${taskId}`,
        meta: { cwd: resolveCwd(request), ...(preset ? { agentPreset: preset.id } : {}) },
        ...(preset ? { setup: async (agentCtx) => { await presets.mount(agentCtx, preset.id); } } : {}),
      });
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
      // A step after the kernel's durable stable commit (archive rendering, the
      // publication sidecar, this state write) can fail while production is
      // already stable — including when a stop signal arrived in between. Adopt
      // that durable fact before deciding anything else; the kernel's stable
      // commit is the authoritative outcome, and marking the task interrupted or
      // reverting a stable experiment would report the opposite of production.
      const adopted = await adoptDurableStable(state).catch(() => null);
      if (adopted !== null) {
        state = await writeState(adopted).catch(() => adopted);
        return;
      }
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
      const needsCleanupRetry = !interrupted
        && !error?.kernelRollback
        && typeof experimentId === 'string' && experimentId !== ''
        && state.revert?.ok !== true
        && agent !== null;
      if (needsCleanupRetry) {
        // Keep the current non-terminal phase and the owner handle; the interval
        // retries `evolution_revert` until it proves recovery. No new task may
        // start until then because the runtime is still occupied.
        pendingCleanup = { taskId, agent, handle, experimentId, phase: state.phase, attempts: 0, armed: false, error: patch.error };
        try {
          state = await patchState(state, {
            ...patch,
            cleanupPending: true,
            revert: state.revert ?? { ok: false, status: 'retry-pending' },
          });
        } catch (writeError) {
          warn(`could not record pending cleanup ${taskId}`, writeError);
        }
        // Only arm the interval retry after the durable state carries the
        // failure and the cleanup marker; otherwise a retry could read the
        // pre-failure document and finalize with the wrong error.
        if (pendingCleanup !== null) pendingCleanup.armed = true;
        handle = null;
        agent = null;
        if (!interrupted) warn(`Desktop task ${taskId} failed`, error);
        return;
      }
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
      if (pendingCleanup?.taskId !== taskId) await releaseClaim(taskId);
      active = null;
    }
  }

  async function retryKindAfterCleanup(job, reverted) {
    const ok = reverted?.runtimeRecovered === true || reverted?.ok === true;
    let state = await readState(job.taskId).catch(() => null);
    if (state === null) return ok;
    // An unproven cleanup keeps the owner, the claim and the retry armed; only
    // a receipt that proves runtime recovery finalizes the task.
    state = await patchState(state, {
      revert: { ok, status: bookmark(reverted?.phase) },
      ...(ok ? { cleanupPending: false } : {}),
    }).catch(() => state);
    if (ok && !isTerminalPhase(state.phase)) {
      try {
        state = await updateState(state, 'failed', {
          error: state.error ?? job.error ?? { code: 'E_DESKTOP_TASK_FAILED', category: 'runtime-trial', digest: null, message: 'The task failed and its Trial cleanup was completed on retry.' },
          result: null,
        });
      } catch (error) {
        warn(`could not record the recovered failed task ${job.taskId}`, error);
      }
    }
    return ok;
  }

  async function disposeCleanupJob(job) {
    try { await job.handle?.dispose?.(); } catch (error) { warn(`could not dispose the cleanup owner ${job.taskId}`, error); }
    await releaseClaim(job.taskId);
  }

  /** One bounded retry of a failed Trial cleanup; interval-driven, no timers of its own. */
  async function retryCleanup() {
    if (pendingCleanup === null || pendingCleanup.armed !== true || disposed) return;
    const job = pendingCleanup;
    job.attempts += 1;
    const signal = AbortSignal.timeout(Math.min(15_000, options.toolTimeoutMs));
    let proven = false;
    let status = 'revert-failed';
    try {
      const reverted = await callToolWithSignal(job.agent, 'evolution_revert', { experimentId: job.experimentId }, 'revert retry', signal);
      proven = reverted?.runtimeRecovered === true || reverted?.ok === true;
      status = bookmark(reverted?.phase);
    } catch (error) {
      const detail = errorProjection(error);
      const classification = classifyCleanupRefusal(detail.message ?? '');
      if (classification.proven) {
        proven = true;
        status = classification.status;
      } else {
        status = detail.code ?? 'revert-failed';
      }
    }
    // The kernel refuses `revert` for a promotion that is still in canary. A
    // canary-observing candidate can only be handed back through the kernel's
    // own regression observation; retrying revert alone would block the runtime
    // and the queue forever even after the observation path recovers.
    if (!proven && (job.phase === 'canary-observing' || job.phase === 'promoting')) {
      try {
        const observed = await callToolWithSignal(job.agent, 'evolution_canary_observe', {
          experimentId: job.experimentId,
          startupVerified: false,
          componentHealth: 'failed',
          dependenciesPresent: true,
          metricRegression: true,
          barrier: { id: `${job.taskId}-cleanup-${job.attempts}`, reached: true },
          evidence: { reason: 'cleanup retry after the canary observation failed' },
        }, 'canary rollback retry', signal);
        if (observed?.phase === 'rolled-back' || observed?.rollback === 'last-known-good') {
          proven = true;
          status = 'last-known-good';
        } else {
          status = bookmark(observed?.phase) ?? status;
        }
      } catch (error) {
        const detail = errorProjection(error);
        const classification = classifyCleanupRefusal(detail.message ?? '');
        if (classification.proven) {
          proven = true;
          status = classification.status;
        } else {
          status = detail.code ?? status;
        }
      }
    }
    const stopped = await retryKindAfterCleanup(job, { ok: proven, runtimeRecovered: proven, phase: status });
    if (!stopped) {
      if (job.attempts === 1 || job.attempts % 10 === 0) warn(`Trial cleanup retry ${job.taskId} is still unproven (attempt ${job.attempts})`, new Error('kernel cleanup did not prove runtime recovery'));
      return;
    }
    await disposeCleanupJob(job);
    pendingCleanup = null;
    if (!disposed) void kick();
  }

  function kick() {
    if (disposed) return queue;
    queue = queue.then(async () => {
      if (pendingCleanup !== null) return;
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
    // The Evolution kernel registers its tools while the profile tree mounts;
    // publishing readiness before that would let the first delegated task fail
    // permanently on a tool that is simply not mounted yet. Wait for the tree,
    // then bound the wait for the kernel tool itself.
    try { await ctx.get?.('loader')?.await?.(); } catch (error) { warn('waiting for the loaded profile failed', error); }
    const kernelDeadline = Date.now() + 60_000;
    while (getTool(undefined, 'evolution_runtime_inspect') === null && Date.now() < kernelDeadline && !disposed) {
      await sleep(250, abort.signal).catch(() => {});
    }
    if (getTool(undefined, 'evolution_runtime_inspect') === null) {
      warn('Evolution kernel tools are not mounted after the readiness wait; tasks will fail until they are', new Error('evolution_runtime_inspect unavailable'));
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
      interval = setInterval(() => { void retryCleanup(); void kick(); }, options.scanIntervalMs);
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
    if (pendingCleanup !== null) {
      const job = pendingCleanup;
      try {
        const signal = AbortSignal.timeout(Math.min(15_000, options.toolTimeoutMs));
        const reverted = await callToolWithSignal(job.agent, 'evolution_revert', { experimentId: job.experimentId }, 'revert during host shutdown', signal);
        await retryKindAfterCleanup(job, reverted);
      } catch (error) {
        warn(`Trial cleanup during host shutdown failed for ${job.taskId}`, error);
        const state = await readState(job.taskId).catch(() => null);
        if (state !== null && !isTerminalPhase(state.phase)) {
          await patchState(state, { cleanupPending: false, revert: { ok: false, status: 'shutdown-cleanup-failed' } }).catch(() => {});
        }
      }
      await disposeCleanupJob(job);
      pendingCleanup = null;
    }
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
    internals: { recoverPreviousTasks, pendingRequests, claim, executeTask, waitForApproval, adoptDurableStable },
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
