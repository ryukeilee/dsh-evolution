/**
 * ACP-side entry of the ACP -> Desktop evolution control channel.
 *
 * This entry is installed only into the `acp` profile. It registers one
 * model-facing tool, `evolution_desktop`, with three actions:
 *
 *   - `delegate` discovers/launches the official Desktop app, writes one
 *     validated task request into the shared channel, and waits (bounded) for
 *     Desktop to move the task out of `accepted` / `running`;
 *   - `status` reads the Desktop-owned task state and can wait for a phase
 *     change or a terminal phase;
 *   - `confirm` writes a promotion approval that is bound to the exact
 *     `experimentId` + `sourceSha256` the Desktop state is waiting on, and only
 *     after the caller passes `confirmation: true` plus the user's own words.
 *
 * The entry never runs the Evolution kernel, never calls a model, never reads
 * Electron private credentials and never modifies the application bundle. The
 * Desktop process keeps sole ownership of task state and promotion authority;
 * this side only writes requests and bound owner approvals.
 *
 * The channel itself (`lib/desktop-task-protocol.js`) is the only contract with
 * the Desktop side. This module adds no second protocol and no polling timer:
 * every wait is bounded by the current tool call.
 */
import { spawn as spawnProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  EXPERIMENT_ID_PATTERN,
  PROFILE_NAMES,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  TASK_ID_PATTERN,
  listJsonFiles,
  mintTaskId,
  pidAlive,
  projectTaskState,
  readJson,
  readReady,
  taskChannelPaths,
  validateApproval,
  validateTaskRequest,
  validateTaskState,
  writeJson,
} from './desktop-task-protocol.js';

export const name = 'dsh-evolution-desktop-task-client';
export const inject = ['tools', 'systemPrompt'];

export const TOOL_NAME = 'evolution_desktop';
export const SYSTEM_PROMPT_SECTION = 'tool:evolution-desktop';
export const SYSTEM_PROMPT_ORDER = 117;

const DEFAULT_APP_BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const DEFAULT_LAUNCH_POLL_MS = 500;
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
const DEFAULT_STATE_POLL_MS = 400;
const DEFAULT_DELEGATE_TIMEOUT_MS = 60_000;
const MAX_STATUS_WAIT_MS = 120_000;
const MAX_ERROR_SUMMARY = 500;
const ACCEPTED_OR_RUNNING = Object.freeze(['accepted', 'running']);

/** The documented plan shape, mirrored as real JSON Schema for the model. */
const planSchema = {
  type: 'object',
  description: 'The evolution plan. It must match the shared protocol exactly; unknown fields are rejected.',
  properties: {
    proposal: {
      type: 'object',
      description: 'Why this capability is worth adding and how success is measured.',
      properties: {
        why: { type: 'string', minLength: 1, maxLength: 4000 },
        target: { type: 'string', minLength: 1, maxLength: 500 },
        impactScope: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 200 } },
        successMetrics: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 500 } },
      },
      required: ['why', 'target', 'impactScope', 'successMetrics'],
      additionalProperties: false,
    },
    composition: {
      type: 'object',
      description: 'The candidate Host-only plugin evaluated by the Desktop kernel.',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        purpose: { type: 'string', minLength: 1, maxLength: 500 },
        code: {
          type: 'object',
          properties: {
            host: { type: 'string', minLength: 1, maxLength: 49152, description: 'Host half source. It must return { name, inject: [\'tools\'], apply(ctx) { ... } }.' },
            client: { type: 'string', minLength: 1, maxLength: 49152 },
          },
          required: ['host'],
          additionalProperties: false,
        },
      },
      required: ['name', 'purpose', 'code'],
      additionalProperties: false,
    },
    verification: {
      type: 'object',
      description: 'Deterministic tool calls the Desktop kernel replays as evidence.',
      properties: {
        targetTool: { type: 'string', minLength: 1, maxLength: 128 },
        observations: { type: 'integer', minimum: 1, maximum: 5 },
        samples: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', minLength: 1, maxLength: 200 },
              tool: { type: 'string', minLength: 1, maxLength: 128 },
              arguments: {},
              expected: {},
            },
            required: ['label', 'tool', 'expected'],
            additionalProperties: false,
          },
        },
      },
      required: ['targetTool', 'observations', 'samples'],
      additionalProperties: false,
    },
    requestedTargetProfiles: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string', enum: [...PROFILE_NAMES] },
      description: 'Profiles a stable promotion may be published to. Defaults to the Desktop-side policy when omitted.',
    },
  },
  required: ['proposal', 'composition', 'verification'],
  additionalProperties: false,
};

const toolParameters = {
  type: 'object',
  description: 'One evolution_desktop action.',
  properties: {
    action: {
      type: 'string',
      enum: ['delegate', 'status', 'confirm'],
      description: 'delegate: hand a plan to Desktop; status: read (and optionally wait for) a task; confirm: write an owner approval the user explicitly gave.',
    },
    plan: planSchema,
    cwd: {
      type: 'string',
      description: 'Absolute working directory for the Desktop task. Omit when the Desktop default is acceptable.',
    },
    taskId: {
      type: 'string',
      description: 'Task id. delegate: optional, a new id is minted. status: defaults to the last delegated task or the newest state file. confirm: required.',
    },
    waitMs: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_STATUS_WAIT_MS,
      description: 'status only. Wait up to this many milliseconds for a phase change or a terminal phase. Defaults to 0.',
    },
    experimentId: { type: 'string', description: 'confirm only. Must equal the pending candidate in the Desktop state.' },
    sourceSha256: { type: 'string', description: 'confirm only. 64 lowercase hex chars; must equal the pending candidate source digest.' },
    confirmation: {
      type: 'boolean',
      description: 'confirm only. Must be true. Any other value is rejected and no approval is written.',
    },
    confirmationText: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'confirm only. The user\'s explicit approval, quoted from the conversation. Never synthesize it.',
    },
    targetProfiles: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string', enum: [...PROFILE_NAMES] },
      description: 'confirm only. Profiles to publish to after stabilization. Defaults to ["acp"].',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const toolOutput = {
  // DSH accepts `{}` as the unconstrained-JSON output schema.
  schema: {},
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

export const systemText = `
The Desktop app owns the only Evolution kernel. Use evolution_desktop when the
user asks in natural language for the assistant to extend its own capabilities:
you organize the request, Desktop decides whether to experiment, whether the
gates pass, whether the result is stable, and whether to roll it back.

For action "delegate", first write an evolution plan.
- proposal: why, target, impactScope, successMetrics.
- composition: name, purpose, code.host. The Host half must be a standalone
  read-only plugin that returns { name, inject: ['tools'], apply(ctx) { ... } }.
  Define the new tool with harness.defineTool({ ... }) and register it with
  harness.registerTool(ctx, tool). Declare isConcurrencySafe: () => true and do
  not access the network, the filesystem, or child processes from that tool.
- verification: targetTool, observations (1-5), and samples (1-5). Each sample
  is a deterministic input (label, tool, arguments) with the exact expected JSON
  result. Keep them small and unambiguous.
- requestedTargetProfiles: usually ["acp"].
Pass the plan, an optional absolute cwd, and an optional taskId. The tool
returns the task phase; if Desktop is not running it starts the official macOS
app, and it reports an actionable error instead of pretending success.

For action "status", pass taskId (it defaults to the task you last delegated or
to the newest state on disk) and optionally waitMs. Call it again instead of
guessing while a task is still "accepted" or "running".

When status returns phase "awaiting-owner-confirmation", you MUST show the user
the experimentId, the candidate sourceSha256, and the gates/decision summary,
then ask for explicit approval in the conversation. Only after the user clearly
approves, call action "confirm" with the same taskId, experimentId and
sourceSha256, confirmation: true, and confirmationText set to the user's exact
words (not a paraphrase). Never infer approval from silence, prior approvals, or
your own judgment; never reuse an approval for another task or experiment. The
Desktop side rejects any mismatch.

After phase "stable", tell the user that a new ACP session loads the promoted
plugin automatically; an already running session does not.
`;

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Bound and sanitize text that may reach the model or a session record. */
function boundedText(text, fallback = 'desktop task client failed') {
  const value = typeof text === 'string' ? text : '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned === '' ? fallback : cleaned).slice(0, MAX_ERROR_SUMMARY);
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : 'E_DESKTOP_TASK_FAILURE';
}

/** One bounded, redacted failure projection; the caller never sees a raw error. */
function failure(action, code, message, extra = {}) {
  return {
    ok: false,
    ...(typeof action === 'string' ? { action } : {}),
    code,
    message: boundedText(message),
    ...extra,
  };
}

function failureFromError(action, error) {
  const raw = errorCode(error);
  if (raw.startsWith('E_DESKTOP_')) return failure(action, raw, `Desktop task channel failed (${raw}).`);
  return failure(action, 'E_DESKTOP_TASK_FAILURE', `Desktop task channel failed (${raw}).`);
}

function resolveClientHome(config) {
  const candidate = config?.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.resolve(candidate);
}

function launchEnvironment(dshHome) {
  const env = { ...process.env };
  // The official application must boot its normal Electron main process; the
  // profile is read from DSH_HOME, not from an operator's ELECTRON_RUN_AS_NODE.
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_HOME = dshHome;
  return env;
}

async function normalizeProfiles(value) {
  if (value === undefined) return { ok: true, value: ['acp'] };
  if (!Array.isArray(value) || value.length === 0 || value.length > PROFILE_NAMES.length) {
    return { ok: false, message: `targetProfiles must be a non-empty array of unique values from ${PROFILE_NAMES.join(', ')}` };
  }
  if (value.some((profile) => !PROFILE_NAMES.includes(profile)) || new Set(value).size !== value.length) {
    return { ok: false, message: `targetProfiles must be unique values from ${PROFILE_NAMES.join(', ')}` };
  }
  return { ok: true, value: [...value] };
}

function readSessionId(exec) {
  try {
    const id = exec?.agent?.id;
    if (typeof id === 'string' && id.length > 0 && id.length <= 200) return id;
  } catch {
    // The session identity is optional metadata; an unreadable execution
    // context must not fail an otherwise valid task.
  }
  return undefined;
}

function createClient(config = {}) {
  const dshHome = resolveClientHome(config);
  const paths = taskChannelPaths(dshHome);
  const spawn = typeof config.spawn === 'function' ? config.spawn : spawnProcess;
  const appBinaryPath = typeof config.appBinaryPath === 'string' && config.appBinaryPath !== ''
    ? config.appBinaryPath
    : (process.env.DSH_DESKTOP_APP_BINARY || DEFAULT_APP_BINARY);
  const platform = typeof config.platform === 'string' ? config.platform : process.platform;
  const pause = typeof config.sleep === 'function' ? config.sleep : sleep;
  const launchPollMs = positiveNumber(config.launchPollMs, DEFAULT_LAUNCH_POLL_MS);
  const launchTimeoutMs = positiveNumber(config.launchTimeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS);
  const statePollMs = positiveNumber(config.statePollMs, DEFAULT_STATE_POLL_MS);
  const delegateTimeoutMs = positiveNumber(config.delegateTimeoutMs, DEFAULT_DELEGATE_TIMEOUT_MS);

  // The last task this process delegated. It only answers a `status` call that
  // omits taskId; it is not an approval or a claim.
  let lastTaskId = null;

  async function currentReadyHost() {
    const ready = await readReady(dshHome);
    if (ready === null) return null;
    return pidAlive(ready.pid) ? ready : null;
  }

  function hostUnavailable(message) {
    return { ok: false, code: 'E_DESKTOP_HOST_UNAVAILABLE', message: boundedText(message) };
  }

  function timeoutSummary() {
    const seconds = Math.max(1, Math.round(launchTimeoutMs / 1000));
    return `The official DeepSeek Harness Desktop did not report readiness at ${paths.ready} within ${seconds}s. `
      + 'If the DeepSeek Harness app is already running an older build, quit and relaunch it so the profile containing dsh-evolution takes effect, then retry. '
      + `You can also start it manually or set DSH_DESKTOP_APP_BINARY (currently ${appBinaryPath}).`;
  }

  function spawnFailureSummary(error) {
    const detail = boundedText(error?.message, 'spawn failed');
    return `Could not launch the official DeepSeek Harness Desktop (${appBinaryPath}): ${detail}. `
      + 'Install the macOS app or set DSH_DESKTOP_APP_BINARY to its executable, then retry.';
  }

  /**
   * Resolve a live Desktop host, launching the official macOS application when
   * none is live. Electron's single-instance lock means a duplicate spawn only
   * focuses the existing window; this function never kills a process and never
   * treats a stale host.json as readiness.
   */
  async function ensureHost() {
    try {
      const ready = await currentReadyHost();
      if (ready !== null) return { ok: true, ready };
    } catch (error) {
      return hostUnavailable(`Could not read the Desktop readiness file: ${errorCode(error)}.`);
    }
    if (platform !== 'darwin') {
      return {
        ok: false,
        code: 'E_DESKTOP_UNSUPPORTED_PLATFORM',
        message: boundedText(`The official DeepSeek Harness Desktop ships as a macOS application; it cannot be started on ${platform}. `
          + 'Run the ACP session on macOS with the same DSH_HOME, or start Desktop there.'),
      };
    }

    let spawnError = null;
    try {
      const child = spawn(appBinaryPath, [], {
        detached: true,
        stdio: 'ignore',
        env: launchEnvironment(dshHome),
      });
      if (child && typeof child.on === 'function') {
        child.on('error', (error) => { spawnError = error; });
      }
      if (child && typeof child.unref === 'function') child.unref();
    } catch (error) {
      spawnError = error;
    }

    const deadline = Date.now() + launchTimeoutMs;
    for (;;) {
      if (spawnError !== null) return hostUnavailable(spawnFailureSummary(spawnError));
      if (Date.now() >= deadline) return hostUnavailable(timeoutSummary());
      await pause(launchPollMs);
      if (spawnError !== null) return hostUnavailable(spawnFailureSummary(spawnError));
      try {
        const ready = await currentReadyHost();
        if (ready !== null) return { ok: true, ready };
      } catch {
        // A readiness file that is being replaced is not a launch failure; keep
        // polling until the deadline, then report the real timeout.
      }
    }
  }

  async function readStateDocument(taskId) {
    const file = path.join(paths.state, `${taskId}.json`);
    try {
      const value = await readJson(file);
      if (value === null) return { state: null, issue: null };
      const validation = validateTaskState(value);
      if (!validation.ok) {
        return { state: null, issue: `state file is invalid: ${validation.issues.slice(0, 4).join('; ')}` };
      }
      return { state: value, issue: null };
    } catch (error) {
      return { state: null, issue: `state file is unreadable (${errorCode(error)})` };
    }
  }

  async function latestStateTaskId() {
    let files;
    try {
      files = await listJsonFiles(paths.state);
    } catch {
      return null;
    }
    let best = null;
    let bestTaskId = null;
    for (const file of files) {
      // The filename is the channel identity; the document's own taskId is
      // validated but never trusted to select a different file on disk.
      const taskId = path.basename(file, '.json');
      if (!TASK_ID_PATTERN.test(taskId)) continue;
      try {
        const value = await readJson(file);
        if (value === null || !validateTaskState(value).ok) continue;
        if (best === null || Date.parse(value.updatedAt) > Date.parse(best.updatedAt)) {
          best = value;
          bestTaskId = taskId;
        }
      } catch {
        // Unreadable or malformed state files do not hide the newest readable one.
      }
    }
    return bestTaskId;
  }

  function projected(state) {
    return projectTaskState(state);
  }

  function delegateSlowMessage(taskId, state, issue) {
    const seconds = Math.max(1, Math.round(delegateTimeoutMs / 1000));
    const base = state === null
      ? `Desktop did not write a readable state for task ${taskId} within ${seconds}s.`
      : `Desktop accepted task ${taskId} but it is still in phase ${state.phase} after ${seconds}s.`;
    const suffix = ' The request is kept on disk; call evolution_desktop with action "status" to read it later.';
    const detail = issue === null ? '' : ` Last state read: ${issue}.`;
    return `${base}${detail}${suffix}`;
  }

  async function delegate(args, exec) {
    const host = await ensureHost();
    if (!host.ok) return failure('delegate', host.code, host.message);

    const taskId = args.taskId === undefined ? mintTaskId() : args.taskId;
    const sessionId = readSessionId(exec);
    const request = {
      schemaVersion: SCHEMA_VERSION,
      protocol: PROTOCOL_VERSION,
      taskId,
      createdAt: new Date().toISOString(),
      requester: {
        profile: 'acp',
        ...(sessionId === undefined ? {} : { sessionId }),
      },
      plan: args.plan,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    };
    const validation = validateTaskRequest(request);
    if (!validation.ok) {
      return failure('delegate', 'E_DESKTOP_TASK_INVALID', `Invalid desktop evolution task: ${validation.issues.slice(0, 6).join('; ')}`, {
        issues: validation.issues.slice(0, 8),
      });
    }

    await writeJson(path.join(paths.inbox, `${request.taskId}.json`), request);
    lastTaskId = request.taskId;

    const deadline = Date.now() + delegateTimeoutMs;
    let latest = null;
    let lastIssue = null;
    for (;;) {
      const observed = await readStateDocument(request.taskId);
      if (observed.state !== null) {
        latest = observed.state;
        lastIssue = null;
        if (!ACCEPTED_OR_RUNNING.includes(observed.state.phase)) {
          return { ok: true, action: 'delegate', ...projected(observed.state) };
        }
      } else if (observed.issue !== null) {
        lastIssue = observed.issue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await pause(Math.min(statePollMs, remaining));
    }

    const lastState = latest === null ? null : projected(latest);
    return failure('delegate', 'E_DESKTOP_TASK_SLOW', delegateSlowMessage(request.taskId, latest, lastIssue), {
      taskId: request.taskId,
      phase: lastState === null ? null : lastState.phase,
      state: lastState,
      ...(lastState === null ? {} : lastState),
    });
  }

  function statusResult(state) {
    return { ok: true, action: 'status', ...projected(state) };
  }

  function statusUnavailable(taskId, issue) {
    if (issue !== null) {
      return failure('status', 'E_DESKTOP_TASK_STATE_INVALID', `Desktop task ${taskId} has an unusable state file: ${issue}`);
    }
    return failure('status', 'E_DESKTOP_TASK_NOT_FOUND', `No Desktop task state was found for ${taskId}. Delegate a task first or pass a taskId.`);
  }

  async function status(args) {
    const waitMs = args.waitMs === undefined ? 0 : args.waitMs;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_STATUS_WAIT_MS) {
      return failure('status', 'E_DESKTOP_TASK_INVALID', `waitMs must be an integer from 0 through ${MAX_STATUS_WAIT_MS}.`);
    }
    let taskId = args.taskId;
    if (taskId === undefined) taskId = lastTaskId === null ? await latestStateTaskId() : lastTaskId;
    if (typeof taskId !== 'string' || taskId === '') {
      return failure('status', 'E_DESKTOP_TASK_NOT_FOUND', 'No Desktop evolution task was found. Delegate a task first or pass a taskId.');
    }
    if (!TASK_ID_PATTERN.test(taskId)) {
      return failure('status', 'E_DESKTOP_TASK_INVALID', 'taskId is not a valid desktop task id.');
    }

    const initial = await readStateDocument(taskId);
    let latest = initial.state;
    let issue = initial.issue;
    if (latest !== null && (waitMs === 0 || projectTaskState(latest).terminal === true)) return statusResult(latest);
    if (waitMs === 0) return statusUnavailable(taskId, issue);

    const initialPhase = latest === null ? null : latest.phase;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await pause(Math.min(statePollMs, remaining));
      const observed = await readStateDocument(taskId);
      if (observed.state !== null) {
        latest = observed.state;
        issue = null;
        if (latest.phase !== initialPhase || projectTaskState(latest).terminal === true) return statusResult(latest);
      } else if (observed.issue !== null) {
        issue = observed.issue;
      }
    }
    if (latest !== null) return statusResult(latest);
    return statusUnavailable(taskId, issue);
  }

  async function confirm(args) {
    if (args.confirmation !== true) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_CONFIRMATION_REQUIRED',
        'confirm requires confirmation: true and the user\'s explicit approval; no approval was written.');
    }
    const { taskId, experimentId, sourceSha256 } = args;
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_INVALID', 'taskId is not a valid desktop task id; no approval was written.');
    }
    if (typeof experimentId !== 'string' || !EXPERIMENT_ID_PATTERN.test(experimentId)) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_INVALID', 'experimentId is invalid; no approval was written.');
    }
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_INVALID', 'sourceSha256 must be 64 lowercase hex characters; no approval was written.');
    }
    const text = args.confirmationText;
    if (typeof text !== 'string' || text.length === 0 || text.length > 2000 || text.trim().length === 0) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_INVALID',
        'confirmationText must quote the user\'s explicit approval (1-2000 characters); no approval was written.');
    }
    const profiles = await normalizeProfiles(args.targetProfiles);
    if (!profiles.ok) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_INVALID', `${profiles.message}; no approval was written.`);
    }

    const observed = await readStateDocument(taskId);
    if (observed.state === null) {
      if (observed.issue !== null) {
        return failure('confirm', 'E_DESKTOP_TASK_STATE_INVALID', `Desktop task ${taskId} has an unusable state file: ${observed.issue}`);
      }
      return failure('confirm', 'E_DESKTOP_TASK_NOT_FOUND', `No Desktop task state was found for ${taskId}; no approval was written.`);
    }
    if (observed.state.phase !== 'awaiting-owner-confirmation') {
      return failure('confirm', 'E_DESKTOP_TASK_NOT_AWAITING_CONFIRMATION',
        `Task ${taskId} is in phase ${observed.state.phase}; only awaiting-owner-confirmation can be approved. No approval was written.`);
    }
    if (observed.state.experimentId !== experimentId || observed.state.candidateSourceSha256 !== sourceSha256) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_MISMATCH',
        `The approval identity does not match the pending candidate in task ${taskId}; nothing was written. Read status again and show the user the current experimentId and sourceSha256.`);
    }

    const approval = {
      schemaVersion: SCHEMA_VERSION,
      protocol: PROTOCOL_VERSION,
      taskId,
      experimentId,
      sourceSha256,
      confirmation: true,
      confirmationText: text,
      targetProfiles: profiles.value,
      confirmedAt: new Date().toISOString(),
    };
    const validation = validateApproval(approval);
    if (!validation.ok) {
      return failure('confirm', 'E_DESKTOP_APPROVAL_INVALID', `The approval document was rejected: ${validation.issues.slice(0, 4).join('; ')}.`);
    }
    await writeJson(path.join(paths.approvals, `${taskId}.json`), approval);
    return {
      ok: true,
      action: 'confirm',
      taskId,
      // The exact document written to disk; Desktop consumes it after matching
      // its own pending candidate.
      approval,
    };
  }

  async function dispatch(args, exec) {
    const action = args?.action;
    if (action === 'delegate') return delegate(args, exec);
    if (action === 'status') return status(args, exec);
    if (action === 'confirm') return confirm(args, exec);
    return failure(typeof action === 'string' ? action : undefined, 'E_DESKTOP_ACTION_INVALID',
      'action must be one of "delegate", "status", or "confirm".');
  }

  return { ensureHost, delegate, status, confirm, dispatch, paths, dshHome, appBinaryPath };
}

export function apply(ctx, config = {}) {
  const client = createClient(config);
  ctx.systemPrompt.section({ name: SYSTEM_PROMPT_SECTION, order: SYSTEM_PROMPT_ORDER, text: systemText });
  ctx.tools.register({
    name: TOOL_NAME,
    description: 'Delegate a structured self-evolution plan to the official DeepSeek Harness Desktop app, read a task\'s durable status, or write an owner approval the user explicitly gave. Desktop owns the Evolution kernel, gates, canary and rollback; this tool never runs a model or approves on its own.',
    parameters: toolParameters,
    output: toolOutput,
    execute: async (args, exec) => {
      try {
        return await client.dispatch(args, exec);
      } catch (error) {
        // Tool errors are read by the model on every later turn, so only the
        // bounded classification crosses this boundary.
        return failureFromError(typeof args?.action === 'string' ? args.action : undefined, error);
      }
    },
  });
  return client;
}
