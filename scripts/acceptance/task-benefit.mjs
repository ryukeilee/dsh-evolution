#!/usr/bin/env node
/**
 * Producer for the task-coupled benefit artifact.
 *
 * The deterministic probe can replay one tool call with identical arguments,
 * but a real workflow recovers from a degraded result (for example a read that
 * truncated a long line) with a different multi-step path. The only admissible
 * evidence for a workflow claim is therefore two sets of real sessions over the
 * same natural task and model:
 *
 *   - the candidate side runs with the candidate Host plugin mounted;
 *   - the baseline side runs the same task without it.
 *
 * This module owns that run. It starts the real ACP host once per session, sends
 * the model request through `model-bridge.mjs` (real inference, the host still
 * executes every tool), records per-session correctness/turns/tool calls/tokens/
 * wall time, and writes the artifact under the Desktop task channel keyed by the
 * task id. The kernel validates structure and binding; it cannot prove that this
 * harness was honest, which is the same trust level as `revalidate --evidence`.
 *
 * Correctness is external: the task declares `expect` as a JSON array of strings
 * (or one string), and every value must appear in the final assistant message.
 * A model that guesses a value is not distinguishable here, so fixture values
 * must be random per run; the acceptance runner generates them.
 *
 * Deliberate limits:
 *   - it never runs paired sessions against the formal DSH_HOME; the caller
 *     supplies an isolated home under the temporary directory. An operator may
 *     designate the channel root of the profile that will read the evidence
 *     (`channelHome`), and only that final artifact write leaves the isolated
 *     home;
 *   - it disables the promoted consumer so the only capability difference is the
 *     preview candidate (the fresh-consumer proof is a separate acceptance);
 *   - a failed model turn or an unreadable reply makes the run incomplete, never
 *     zero;
 *   - it does not choose a tool for the model and does not retry a failed turn.
 */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BRIDGE_MODEL, startModelBridge, usageTotals } from './model-bridge.mjs';

export const TASK_BENEFIT_RUNS = Object.freeze({ min: 3, max: 5 });
export const TASK_BENEFIT_MODEL = DEFAULT_BRIDGE_MODEL;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PROMPT = 2000;
const MAX_EXPECT = 500;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCENARIO_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Bounded task definition validation; returns the normalized task or throws. */
export function normalizeTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('task must be an object');
  const id = typeof task.id === 'string' ? task.id.trim() : '';
  if (!SCENARIO_ID.test(id)) throw new Error('task.id must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$');
  const prompt = typeof task.prompt === 'string' ? task.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT) throw new Error(`task.prompt must be 1-${MAX_PROMPT} characters`);
  const expect = typeof task.expect === 'string' ? task.expect.trim() : '';
  if (!expect || expect.length > MAX_EXPECT) throw new Error(`task.expect must be 1-${MAX_EXPECT} characters`);
  const tokens = parseExpectTokens(expect);
  if (tokens.length === 0) throw new Error('task.expect declares no expected value');
  // Optional per-path binding: when a task declares which value belongs to
  // which file, `exercised` requires that file's own first read to carry it.
  // The artifact still hashes only prompt/expect, so this cannot widen what a
  // plan or the kernel validates; it makes the harness's own attribution
  // stricter. Every expected token must be mapped and every mapped token must
  // be expected, so a partial mapping cannot weaken the check.
  const reads = Array.isArray(task.reads) ? task.reads.map((row) => ({
    path: typeof row?.path === 'string' ? row.path.trim() : '',
    token: typeof row?.token === 'string' ? row.token.trim() : '',
  })) : [];
  if (reads.length > 0) {
    if (reads.length > 32) throw new Error('task.reads must carry at most 32 entries');
    if (reads.some((row) => !row.path || row.path.length > 300 || !path.isAbsolute(row.path) || !row.token || row.token.length > 200)) {
      throw new Error('task.reads entries need an absolute bounded path and token');
    }
    if (reads.some((row) => !tokens.includes(row.token))) throw new Error('task.reads token is not declared in task.expect');
    if (tokens.some((token) => !reads.some((row) => row.token === token))) {
      throw new Error('task.reads must map every expected token to a path');
    }
  }
  return { id, prompt, expect, tokens, reads };
}

/**
 * `expect` is either one literal string or a JSON array of strings. The plan
 * binds only its sha256, so the array form lets a multi-file task require every
 * answer without widening the contract.
 */
export function parseExpectTokens(expect) {
  const raw = String(expect ?? '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim());
    } catch { /* treated as one literal below */ }
  }
  return [raw];
}

/** Every declared value must appear in the final assistant text. */
export function answerMatches(text, tokens) {
  if (typeof text !== 'string') return false;
  const list = Array.isArray(tokens) ? tokens : parseExpectTokens(tokens);
  return list.length > 0 && list.every((token) => text.includes(token));
}

/**
 * Join a requested path to the path the host/ACP reports. The harness declares
 * the expected file as an absolute path. A relative actual path is resolved
 * against the session cwd first, so `a.txt` under `/home` matches
 * `/home/a.txt` but not `/home/sub/a.txt`; without a cwd it is accepted only as
 * a suffix, and two absolute paths must be identical.
 */
function hasParentSegment(value) {
  return typeof value === 'string' && value.split('/').includes('..');
}

export function readPathMatches(actual, expected, cwd = null) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (hasParentSegment(actual) || hasParentSegment(expected)) return false;
  const normalize = (value) => {
    const normalized = path.posix.normalize(value);
    return normalized === '.' ? '' : normalized;
  };
  const left = normalize(actual);
  const right = normalize(expected);
  if (!left || !right) return false;
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    const resolve = (value) => path.posix.normalize(path.posix.join(normalize(cwd), value));
    const absoluteLeft = path.isAbsolute(left) ? path.posix.normalize(left) : resolve(left);
    const absoluteRight = path.isAbsolute(right) ? path.posix.normalize(right) : resolve(right);
    return absoluteLeft === absoluteRight;
  }
  if (left === right) return true;
  if (path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  return right.endsWith('/' + left);
}

/**
 * Identify the tool ACP actually executed for one `tool_call` update. The
 * `title` and `rawInput` belong to that call id; the model decision is only a
 * positional fallback. If the title disagrees with the positionally joined
 * decision, its arguments are not trusted (the order is not reliable), but the
 * call identity still comes from the title.
 */
export function toolCallDescriptor(call, index, toolTurns, toolNames, cwd = null, usedDecisions = null, reportedPath = null) {
  const structuredName = typeof call?.name === 'string' && call.name.trim() !== '' ? call.name.trim() : null;
  const title = typeof call?.title === 'string' && call.title.trim() !== '' ? call.title.trim() : null;
  const label = structuredName ?? title;
  const decision = toolTurns?.[index]?.decision;
  const decisionName = typeof toolNames?.[index] === 'string' ? toolNames[index] : null;
  const offered = Array.isArray(toolTurns?.[index]?.tools) ? toolTurns[index].tools : [];
  // ACP's structured name is authoritative; title is the human-facing fallback.
  const labelIsTool = label !== null && (label === decisionName || offered.includes(label));
  const rawInput = call?.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput)
    ? call.rawInput : null;
  const decisionArguments = decision?.arguments && typeof decision.arguments === 'object' && !Array.isArray(decision.arguments)
    ? decision.arguments : null;
  // Position is only trustworthy when the label names the decision's tool and
  // that tool appears once. With two same-name calls, a reversed transport order
  // would otherwise lend a tail read the start read's offset.
  const ambiguous = decisionName !== null && toolNames.filter((name) => name === decisionName).length > 1;
  const positionTrusted = !ambiguous && label !== null && label === decisionName;
  const name = labelIsTool ? label : null;
  const rawFile = rawInput && typeof rawInput.file_path === 'string' && rawInput.file_path.trim() !== '';
  const effectivePath = rawFile ? rawInput.file_path
    : (typeof reportedPath === 'string' && reportedPath.trim() !== '' ? reportedPath : null);
  const rawOffsetValid = Number.isInteger(rawInput?.offset) && rawInput.offset > 0;
  let argumentsValue = {};
  let inputKnown = false;
  if (name === 'read') {
    const unresolvedPath = effectivePath !== null && hasParentSegment(effectivePath);
    // Resolve same-name decisions by path. The result path can supply the file
    // when ACP only echoed an offset. Unclaimed decisions are considered so an
    // explicit continuation claims first and the earlier default-offset read
    // can then match the remaining decision.
    const sameTool = (Array.isArray(toolTurns) ? toolTurns : [])
      .filter((turn) => turn?.decision?.tool === 'read');
    let candidates = effectivePath && !unresolvedPath ? sameTool.filter((turn) => {
      const path = turn?.decision?.arguments?.file_path;
      return typeof path === 'string' && path.trim() !== ''
        && (readPathMatches(effectivePath, path, cwd) || readPathMatches(path, effectivePath, cwd));
    }) : [];
    if (usedDecisions) candidates = candidates.filter((turn) => !usedDecisions.has(turn.decision));
    const decisionOffset = (turn) => {
      const value = turn?.decision?.arguments?.offset;
      if (value === undefined) return 1;
      return Number.isInteger(value) && value > 0 ? value : NaN;
    };
    // An ACP-reported offset must match the decision exactly, including the
    // decision's implicit default of 1. An omitted ACP offset may inherit the
    // unique remaining decision.
    if (effectivePath && rawOffsetValid) {
      candidates = candidates.filter((turn) => decisionOffset(turn) === rawInput.offset);
    }
    // Every path-reported read must claim exactly one matching decision, even
    // when ACP supplied its own offset. This keeps repeated calls from reusing
    // one decision or borrowing another file's offset.
    let alignedDecision = null;
    if (effectivePath) {
      if (candidates.length === 1) alignedDecision = candidates[0].decision;
      else if (candidates.length === 0 && positionTrusted
        && !(decisionArguments && typeof decisionArguments.file_path === 'string' && decisionArguments.file_path.trim() !== '')) {
        // The decision did not name a file; the result path is the only path
        // evidence, and the unique positional decision cannot contradict it.
        alignedDecision = decision;
      }
    } else if (positionTrusted) {
      alignedDecision = decision;
    }
    let offsetConflict = false;
    if (alignedDecision && rawOffsetValid) {
      const value = alignedDecision.arguments?.offset;
      const normalized = value === undefined ? 1 : (Number.isInteger(value) && value > 0 ? value : NaN);
      if (normalized !== rawInput.offset) {
        alignedDecision = null;
        offsetConflict = true;
      }
    }
    if (alignedDecision && usedDecisions) {
      if (usedDecisions.has(alignedDecision)) alignedDecision = null;
      else usedDecisions.add(alignedDecision);
    }
    const alignedArguments = alignedDecision?.arguments && typeof alignedDecision.arguments === 'object'
      && !Array.isArray(alignedDecision.arguments) ? alignedDecision.arguments : null;
    if (offsetConflict) {
      inputKnown = false;
    } else if (unresolvedPath || (effectivePath && alignedDecision === null)) {
      inputKnown = false;
    } else if (rawOffsetValid) {
      argumentsValue = rawInput;
      inputKnown = true;
    } else if (alignedArguments) {
      argumentsValue = { ...alignedArguments, ...(rawInput ?? {}) };
      inputKnown = true;
    } else {
      inputKnown = false;
    }
    // The final adopted offset must be absent (default 1) or a positive
    // integer. An explicit null/0/fraction/string is not evidence.
    if (inputKnown && Object.prototype.hasOwnProperty.call(argumentsValue, 'offset')
      && !(Number.isInteger(argumentsValue.offset) && argumentsValue.offset > 0)) {
      inputKnown = false;
    }
  } else {
    argumentsValue = rawInput ?? (positionTrusted ? decisionArguments : null) ?? {};
    inputKnown = rawInput !== null || positionTrusted;
  }
  return {
    name,
    arguments: argumentsValue,
    inputKnown,
  };
}
function normalizeReadPath(value, cwd) {
  if (typeof value !== 'string' || value === '') return value;
  if (hasParentSegment(value)) return value;
  const normalized = value;
  if (path.isAbsolute(normalized)) return path.normalize(normalized);
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd, normalized) : normalized;
}

function toolResultTextBlocks(update) {
  const blocks = Array.isArray(update?.content) ? update.content : [];
  const texts = [];
  for (const block of blocks) {
    if (typeof block?.text === 'string') texts.push(block.text);
    else if (typeof block?.content?.text === 'string') texts.push(block.content.text);
  }
  return texts;
}

/** Flatten the text blocks the ACP transport reports for one tool result. */
function toolUpdateText(update) {
  const blocks = Array.isArray(update?.content) ? update.content : [];
  const parts = [];
  for (const block of blocks) {
    if (typeof block?.text === 'string') parts.push(block.text);
    else if (typeof block?.content?.text === 'string') parts.push(block.content.text);
  }
  return parts.join('\n');
}

/** A tool result only proves an effect once the transport reports it complete. */
function completedToolUpdate(update) {
  return update?.status === 'completed' || update?.status === 'success';
}

/** A completed result that the transport did not also mark as an error. */
export function successfulToolResult(update) {
  return completedToolUpdate(update) && update?.isError !== true && update?.is_error !== true;
}

function parseToolResultText(text) {
  const value = typeof text === 'string' ? text : '';
  const startsWithPath = /^\s*<path>/u.test(value);
  const hasEnvelopeTag = /<\/?path>|<\/?content>/u.test(value);
  // Only text without any envelope structure may use the bare-text path.
  if (!startsWithPath) {
    if (hasEnvelopeTag) return { path: null, body: '', invalid: true };
    return { path: null, body: value.trim(), invalid: false };
  }
  const pathMatch = /^\s*<path>([\s\S]*?)<\/path>[ \t]*(?:\r?\n|$)/u.exec(value);
  if (!pathMatch) return { path: null, body: '', invalid: true };
  const path = pathMatch[1].trim() || null;
  if (!path) return { path: null, body: '', invalid: true };
  const pathTags = (value.match(/<path>/gu) ?? []).length;
  const openTags = (value.match(/<content>/gu) ?? []).length;
  const closeTags = (value.match(/<\/content>/gu) ?? []).length;
  if (pathTags !== 1 || openTags !== 1 || closeTags !== 1) return { path, body: '', invalid: true };
  let body = value.slice(pathMatch[0].length);
  body = body.replace(/^\s*<type>[^<]*<\/type>\s*/u, '');
  const contentMatch = /^\s*<content>([\s\S]*)<\/content>\s*$/u.exec(body);
  if (!contentMatch) return { path, body: '', invalid: true };
  return { path, body: contentMatch[1].trim(), invalid: false };
}

/**
 * Merge ACP call input from the initial tool_call and later tool_call_update
 * notifications. A terminal notification locks the known path/offset; later
 * updates may fill a missing field but may not rewrite a locked one.
 */
export function mergeAcpInputs(calls, updates, cwd = null) {
  const inputs = new Map();
  const locked = new Set();
  let conflict = false;
  const terminal = (update) => update?.status === 'completed' || update?.status === 'success'
    || update?.status === 'failed' || update?.status === 'error'
    || update?.isError === true || update?.is_error === true;
  const merge = (id, rawInput) => {
    if (typeof id !== 'string' || !rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return;
    const current = inputs.get(id) ?? {};
    const next = { ...current, ...rawInput };
    if (locked.has(id)) {
      for (const key of ['file_path']) {
        if (typeof current[key] === 'string' && typeof rawInput[key] === 'string'
          && !readPathMatches(rawInput[key], current[key], cwd) && !readPathMatches(current[key], rawInput[key], cwd)) {
          conflict = true;
        }
      }
      for (const key of ['file_path', 'offset']) {
        if (current[key] !== undefined) next[key] = current[key];
      }
      if (rawInput.offset !== undefined && current.offset !== undefined && rawInput.offset !== current.offset) conflict = true;
    }
    inputs.set(id, next);
  };
  const known = new Set();
  for (const update of Array.isArray(updates) ? updates : []) {
    const kind = update?.sessionUpdate;
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue;
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
    if (id === null) continue;
    if (kind === 'tool_call') {
      known.add(id);
    } else if (!known.has(id)) {
      // A tool_call_update that arrives before its tool_call cannot be
      // attributed to a future call.
      conflict = true;
      continue;
    }
    merge(id, update.rawInput);
    if (terminal(update)) locked.add(id);
  }
  return { inputs, conflict };
}

export function terminalNotificationMissingId(updates) {
  for (const update of Array.isArray(updates) ? updates : []) {
    if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') continue;
    const terminal = update.status === 'completed' || update.status === 'success'
      || update.status === 'failed' || update.status === 'error'
      || update.isError === true || update.is_error === true;
    if (terminal && (typeof update.toolCallId !== 'string' || update.toolCallId === '')) return true;
  }
  return false;
}

export function terminalToolResults(updates, cwd = null) {
  const paths = new Map();
  const texts = new Map();
  const bodies = new Map();
  const conflicts = new Set();
  for (const update of Array.isArray(updates) ? updates : []) {
    const kind = update?.sessionUpdate;
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue;
    if (!successfulToolResult(update)) continue;
    const id = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : null;
    if (id === null) continue;
    const blocks = toolResultTextBlocks(update);
    // An initial completed tool_call without content is only a status, not a
    // result; a later update may carry the actual body.
    if (kind === 'tool_call' && blocks.length === 0) continue;
    const parsedBlocks = blocks.map((text) => parseToolResultText(text));
    // Multiple complete envelopes in one notification are separate results,
    // not one concatenated body. Bare text blocks of one result may still be
    // joined.
    const hasEnvelope = parsedBlocks.some((parsed) => parsed.path !== null || parsed.invalid === true);
    const results = hasEnvelope
      ? parsedBlocks
      : [{ path: null, body: blocks.join('\n').trim(), invalid: false }];
    for (const parsed of results) {
      const { path: resultPath, body } = parsed;
      if (texts.has(id)) {
        if (bodies.get(id) !== body) conflicts.add(id);
        if (resultPath) {
          if (!paths.has(id)) paths.set(id, resultPath);
          else if (paths.get(id) !== resultPath
            && !readPathMatches(resultPath, paths.get(id), cwd) && !readPathMatches(paths.get(id), resultPath, cwd)) {
            conflicts.add(id);
          }
        }
      } else {
        texts.set(id, body);
        bodies.set(id, body);
        if (resultPath) paths.set(id, resultPath);
      }
    }
  }
  return { paths, texts, conflicts };
}

export function terminalToolResultPaths(updates, cwd = null) {
  const { paths, conflicts } = terminalToolResults(updates, cwd);
  return { paths, conflicts };
}

/**
 * Count failed host tool calls from both notifications. ACP may mark the
 * initial `tool_call` as failed and never send a `tool_call_update`; counting
 * only updates would let a whole-session retry hide that product failure. The
 * same call id seen in both notifications is one failure.
 */
export function failedToolCallIds(updates) {
  const ids = new Set();
  let anonymous = 0;
  for (const update of Array.isArray(updates) ? updates : []) {
    if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') continue;
    if (!(update.status === 'failed' || update.status === 'error'
      || update.isError === true || update.is_error === true)) continue;
    if (typeof update.toolCallId === 'string') ids.add(update.toolCallId);
    else anonymous += 1;
  }
  return { ids, anonymous, count: ids.size + anonymous };
}

/**
 * Count tool calls that never reached a terminal notification. A read with a
 * path/offset but no final result is incomplete evidence, not a zero-failure
 * host call, so a whole-session retry must not hide it.
 */
export function missingTerminalToolCalls(updates) {
  const terminal = new Set();
  const calls = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    const id = typeof update?.toolCallId === 'string' ? update.toolCallId : null;
    if (update?.sessionUpdate === 'tool_call') calls.push(id);
    if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') continue;
    const done = update.status === 'completed' || update.status === 'success'
      || update.status === 'failed' || update.status === 'error'
      || update.isError === true || update.is_error === true;
    if (done && id !== null) terminal.add(id);
  }
  return calls.filter((id) => id === null || !terminal.has(id)).length;
}

/** Billing fields must be real finite numbers; optional cache.read defaults to 0. */
function finiteUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  if (typeof usage.input !== 'number' || !Number.isFinite(usage.input)) return false;
  if (typeof usage.output !== 'number' || !Number.isFinite(usage.output)) return false;
  if (usage.cache !== undefined) {
    if (!usage.cache || typeof usage.cache !== 'object') return false;
    if (usage.cache.read !== undefined && (typeof usage.cache.read !== 'number' || !Number.isFinite(usage.cache.read))) return false;
  }
  return true;
}

const SAFE_ERROR_CODE = /^E_(?:DESKTOP|ACP|EVOLUTION|DSH|EXPERIENCE)_[A-Z0-9_]{2,63}$/;
// A whole-session replacement is only for a pilot transport failure. An own-tool
// call is a measurement-integrity failure, not a formatting slip: retrying it
// would let a session that bypassed the host transcript be replaced by a clean
// one and still produce a complete artifact.
const PILOT_RETRYABLE_REASONS = new Set([
  'model-process-failed',
  'reply-not-text',
  'reply-has-no-object',
  'reply-object-invalid',
  'reply-object-unterminated',
  'decision-shape-invalid',
]);

/** True only when every failed turn is a retryable pilot transport failure. */
export function pilotTransportRetryable(turns) {
  const failed = (Array.isArray(turns) ? turns : []).filter((turn) => turn?.ok !== true);
  return failed.length > 0 && failed.every((turn) => typeof turn.reason === 'string' && PILOT_RETRYABLE_REASONS.has(turn.reason));
}

/** Keep only fixed reason codes in a persisted row; raw exception text stays out. */
export function pilotFailureReasons(turns) {
  const known = new Set([...PILOT_RETRYABLE_REASONS, 'pilot-used-own-tools', 'pilot-transport-incomplete']);
  return [...new Set((Array.isArray(turns) ? turns : [])
    .filter((turn) => turn?.ok !== true)
    .map((turn) => (typeof turn.reason === 'string' && known.has(turn.reason) ? turn.reason : 'pilot-transport-error')))].slice(0, 4);
}

/** A whole-session replacement needs a retryable pilot failure, complete attribution and no product tool failure. */
export function retryableSession(row) {
  return row?.toolFailures === 0 && row?.attributionComplete === true && row?.retryableTransportFailure === true;
}

/** Count tool names so a reordered but identical call set still aligns. */
function toolCounts(names) {
  const counts = new Map();
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function sameToolCounts(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, count] of left) if (right.get(name) !== count) return false;
  return true;
}

/** Compare two tool-name lists as multisets (order is not significant). */
export function toolNameCountsMatch(left, right) {
  return sameToolCounts(toolCounts(left), toolCounts(right));
}

/** Only a trusted structured code in an allowlist may reach the evidence. */
export function safeErrorCode(value) {
  const code = typeof value === 'string' ? value : value?.code;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : null;
}

function failureProjection(error) {
  const text = String(error?.message ?? error ?? '');
  const stage = /initialize/.test(text) ? 'initialize'
    : /session\/new/.test(text) ? 'session-new'
      : /session\/prompt/.test(text) ? 'prompt' : 'transport';
  const code = safeErrorCode(error);
  return { stage, category: 'acp-failure', code };
}

/**
 * Turn one ACP session's transport records into the measured row.
 *
 * `turns` is the model-bridge slice for this session (`tools` is the live tool
 * surface of each decision). Version and stop turns are excluded from the
 * decision metrics exactly like the existing acceptance.
 */
export function extractSessionEvidence({ label, side, turns, updates, assistantText, expectedTokens, candidateTool = null, durationMs = 0, expectedReads = null, cwd = null }) {
  const decisionTurns = (Array.isArray(turns) ? turns : []).filter((turn) => (turn?.tools?.length ?? 0) > 0);
  // Only a turn that actually chose a tool has a `tool_call` update. Keeping
  // that list (rather than indexing every decision turn) means a stop turn can
  // never shift a later call's arguments onto the wrong id.
  const toolTurns = decisionTurns.filter((turn) => typeof turn?.decision?.tool === 'string' && turn.decision.tool.trim() !== '');
  const toolNames = toolTurns.map((turn) => turn.decision.tool);
  const usage = usageTotals(decisionTurns);
  // A decision without a usage record is not a zero-cost turn: the artifact's
  // token budget would then be understated. The session is incomplete and the
  // kernel rejects the whole artifact.
  const usageComplete = decisionTurns.every((turn) => finiteUsage(turn.usage));
  const failedModelTurns = (Array.isArray(turns) ? turns : []).filter((turn) => turn.ok !== true).length;
  const failedUpdates = failedToolCallIds(updates);
  const missingTerminals = missingTerminalToolCalls(updates);
  const missingTerminalId = terminalNotificationMissingId(updates);
  const terminalIds = new Set();
  const resultTextIds = new Set();
  for (const update of Array.isArray(updates) ? updates : []) {
    const id = typeof update?.toolCallId === 'string' ? update.toolCallId : null;
    if (id === null) continue;
    if (update.status === 'completed' || update.status === 'success'
      || update.status === 'failed' || update.status === 'error'
      || update.isError === true || update.is_error === true) terminalIds.add(id);
  }
  // Map one `tool_call` update to its model decision by order: ACP reports one
  // tool call per decision turn, in the same order. The id then joins the
  // completed result update to the tool name and the arguments the model chose.
  const calls = (Array.isArray(updates) ? updates : []).filter((update) => update?.sessionUpdate === 'tool_call');
  const mergedInputs = mergeAcpInputs(calls, updates, cwd);
  const inputByCall = mergedInputs.inputs;
  const terminalPaths = terminalToolResults(updates, cwd);
  for (const [id, body] of terminalPaths.texts) if (body) resultTextIds.add(id);
  const resultPathByCall = terminalPaths.paths;
  const hasRawOffset = (call) => {
    const input = inputByCall.get(call?.toolCallId) ?? call?.rawInput;
    return Number.isInteger(input?.offset) && input.offset > 0;
  };
  const orderedCalls = calls.map((call, index) => ({ call, index }))
    .sort((left, right) => Number(hasRawOffset(right.call)) - Number(hasRawOffset(left.call)));
  const byId = new Map();
  const seenCallIds = new Set();
  let attributionComplete = calls.length === toolTurns.length && missingTerminals === 0
    && !missingTerminalId && terminalPaths.conflicts.size === 0 && !mergedInputs.conflict;
  const usedReadDecisions = new Set();
  orderedCalls.forEach(({ call, index }) => {
    const effectiveCall = typeof call.toolCallId === 'string' && inputByCall.has(call.toolCallId)
      ? { ...call, rawInput: inputByCall.get(call.toolCallId) }
      : call;
    const descriptor = toolCallDescriptor(effectiveCall, index, toolTurns, toolNames, cwd, usedReadDecisions,
      resultPathByCall.get(call.toolCallId) ?? null);
    if (typeof call.toolCallId !== 'string' || seenCallIds.has(call.toolCallId)) attributionComplete = false;
    if (typeof call.toolCallId === 'string') seenCallIds.add(call.toolCallId);
    if (typeof descriptor.name !== 'string') attributionComplete = false;
    if (typeof call.toolCallId === 'string' && typeof descriptor.name === 'string') {
      byId.set(call.toolCallId, descriptor);
    }
  });
  const callNames = calls.map((call) => byId.get(call.toolCallId)?.name)
    .filter((name) => typeof name === 'string');
  const callIdSet = new Set(calls.map((call) => call.toolCallId).filter((id) => typeof id === 'string'));
  for (const id of terminalIds) if (!callIdSet.has(id)) attributionComplete = false;
  for (const update of Array.isArray(updates) ? updates : []) {
    if (update?.sessionUpdate !== 'tool_call_update') continue;
    if (typeof update.toolCallId !== 'string' || !callIdSet.has(update.toolCallId)) attributionComplete = false;
  }
  const attributionAligned = calls.length === toolTurns.length
    && callNames.length === calls.length
    && toolNameCountsMatch(toolNames, callNames);
  attributionComplete = attributionComplete && attributionAligned;
  let missingReadResults = 0;
  for (const call of calls) {
    const meta = byId.get(call.toolCallId);
    if (meta?.name !== 'read') continue;
    if (failedUpdates.ids.has(call.toolCallId)) continue;
    if (!resultTextIds.has(call.toolCallId) && terminalIds.has(call.toolCallId)) missingReadResults += 1;
  }
  attributionComplete = attributionComplete && missingReadResults === 0;
  const toolFailures = failedUpdates.count + missingTerminals + missingReadResults;
  const failures = failedModelTurns + toolFailures;
  // A read is a *request* before it is a result. Register the first request of
  // each path from the ordered tool_call updates, then accept it only if that
  // exact call returned successfully from offset 1. A failed or tail-first
  // first request followed by a start reread is not mechanism proof.
  const readResults = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') continue;
    if (terminalPaths.conflicts.has(update.toolCallId)) continue;
    if (failedUpdates.ids.has(update.toolCallId)) continue;
    if (!successfulToolResult(update)) continue;
    if (readResults.has(update.toolCallId)) continue;
    const call = byId.get(update.toolCallId);
    if (call?.name !== 'read') continue;
    const text = terminalPaths.texts.get(update.toolCallId);
    if (!text) continue;
    const mergedPath = terminalPaths.paths.get(update.toolCallId) ?? null;
    const renderedPath = mergedPath;
    const argumentPath = typeof call.arguments.file_path === 'string' && call.arguments.file_path.trim() !== ''
      ? call.arguments.file_path : null;
    if (!renderedPath && !argumentPath) { attributionComplete = false; continue; }
    // The rendered result names the file the host actually read. If it
    // disagrees with the request, this call cannot prove either file's effect.
    if (renderedPath && argumentPath
      && !readPathMatches(argumentPath, renderedPath, cwd)
      && !readPathMatches(renderedPath, argumentPath, cwd)) {
      attributionComplete = false;
      continue;
    }
    const requestedOffset = Number.isInteger(call.arguments.offset) && call.arguments.offset > 0
      ? call.arguments.offset : 1;
    readResults.set(update.toolCallId, { text, path: renderedPath ?? argumentPath, offset: requestedOffset });
  }
  const readRequests = [];
  for (const call of calls) {
    const meta = byId.get(call.toolCallId);
    if (meta?.name !== 'read') continue;
    const argumentPath = typeof meta.arguments.file_path === 'string' && meta.arguments.file_path.trim() !== ''
      ? meta.arguments.file_path : null;
    if (!meta.inputKnown) attributionComplete = false;
    const offset = meta.inputKnown && Number.isInteger(meta.arguments.offset) && meta.arguments.offset > 0
      ? meta.arguments.offset : (meta.inputKnown ? 1 : null);
    const path = readResults.get(call.toolCallId)?.path ?? argumentPath ?? null;
    if (typeof path !== 'string' || path === '') attributionComplete = false;
    // The result path is authoritative when it exists; the requested path is the
    // fallback for a transport that does not render it. An untrusted input has
    // no provable offset, so it can never be a first-read proof.
    readRequests.push({ callId: call.toolCallId, path, offset });
  }
  const correct = answerMatches(assistantText, expectedTokens);
  const firstRequestByPath = new Map();
  for (const request of readRequests) {
    if (typeof request.path !== 'string' || request.path === '') continue;
    const key = normalizeReadPath(request.path, cwd);
    if (!firstRequestByPath.has(key)) firstRequestByPath.set(key, request);
  }
  const firstReads = [];
  for (const request of firstRequestByPath.values()) {
    if (request.offset !== 1) continue;
    const result = readResults.get(request.callId);
    if (result) firstReads.push(result.text);
  }
  // A token is proof only when it came from the first start read of its own
  // path. Counting all first reads together lets a value from file B stand in
  // for a missing value in file A.
  const reads = Array.isArray(expectedReads)
    ? expectedReads.filter((row) => typeof row?.path === 'string' && row.path !== '' && typeof row?.token === 'string' && row.token !== '')
    : [];
  const boundReads = reads.map((expected) => {
    const request = readRequests.find((candidate) => readPathMatches(candidate.path, expected.path, cwd));
    const result = request ? readResults.get(request.callId) : null;
    return Boolean(request && request.offset === 1 && result && result.text.includes(expected.token));
  });
  // Every call must have a verifiable identity and a read must have a usable
  // path. An unidentified or pathless call could be the first read of a path,
  // so its presence makes any later start read an unreliable substitute.
  const exercised = attributionAligned && attributionComplete && expectedTokens.length > 0 && (reads.length > 0
    ? boundReads.every(Boolean)
    : expectedTokens.every((token) => firstReads.some((text) => text.includes(token))));
  return {
    label,
    side,
    correct,
    exercised,
    attributionComplete,
    usedCandidate: candidateTool !== null && callNames.includes(candidateTool),
    usageComplete,
    toolFailures,
    turns: decisionTurns.length,
    toolCalls: callNames.length,
    toolNames: callNames,
    failures,
    tokens: usageComplete ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens : 0,
    inputTokens: usageComplete ? usage.inputTokens : 0,
    outputTokens: usageComplete ? usage.outputTokens : 0,
    cacheReadTokens: usageComplete ? usage.cacheReadTokens : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    readResultCount: readResults.size,
    readResultCharacters: [...readResults.values()].reduce((total, result) => total + result.text.length, 0),
  };
}

/** Sum the per-session rows; turns/toolCalls/tokens/time are additive. */
export function aggregateSessions(sessions) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const sum = (key) => rows.reduce((total, row) => total + (Number.isFinite(row?.[key]) ? row[key] : 0), 0);
  return {
    sessions: rows.length,
    correct: rows.filter((row) => row.correct === true).length,
    failures: rows.filter((row) => row.failures > 0).length,
    turns: sum('turns'),
    toolCalls: sum('toolCalls'),
    tokens: sum('tokens'),
    durationMs: sum('durationMs'),
  };
}

/**
 * Build the artifact the kernel validates. `taskId` is the Desktop task
 * identity; `candidateHost` is the exact Host source the Trial will mount.
 */
export function buildTaskBenefitArtifact({ taskId, task, candidateHost, model, host, runs, baseline, candidate, adoption }) {
  const baselineSummary = aggregateSessions(baseline);
  const candidateSummary = aggregateSessions(candidate);
  return {
    schemaVersion: 1,
    kind: 'paired-real-session',
    complete: true,
    taskId,
    task: { id: task.id, promptSha256: sha256(task.prompt), expectSha256: sha256(task.expect) },
    candidateHostSha256: sha256(candidateHost),
    model,
    host: { dsh: host.dsh, cordis: host.cordis },
    runs: { baseline: runs, candidate: runs },
    baseline: baselineSummary,
    candidate: candidateSummary,
    adoption,
    // Provenance is intentional and ignored by the validator: it makes the
    // artifact's token basis auditable without weakening the contract. Raw
    // transcripts and tool output deliberately stay in the harness report, not
    // in the channel artifact.
    tokenBasis: 'model-bill: input + output + cache.read',
  };
}

/**
 * Resolve the nearest existing ancestor and append the missing components, so
 * a symlinked ancestor cannot be hidden behind two or more missing segments.
 */
function canonicalizeSync(target) {
  const suffix = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(realpathSync(current), ...suffix.slice().reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** Refuse anything that could be the operator's formal data root. */
export function assertIsolatedHome(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('home must be an absolute isolated path');
  const resolved = path.resolve(home);
  // A path under the temporary directory can still be a symlink into the
  // formal data root. Resolve the real target before any write or launch.
  const canonical = canonicalizeSync(resolved);
  const formal = (() => { try { return realpathSync(path.join(os.homedir(), '.dsh')); } catch { return path.join(os.homedir(), '.dsh'); } })();
  if (canonical === formal || canonical.startsWith(`${formal}${path.sep}`)) {
    throw new Error('refusing to run paired sessions against the formal DSH_HOME');
  }
  // macOS os.tmpdir() is /var/folders/..., while /tmp is the same world through
  // a symlink. Both are temporary roots; anything else is not an isolated home.
  const temporaryRoots = [...new Set([os.tmpdir(), '/tmp', '/private/tmp'].flatMap((root) => {
    try { return [path.resolve(root), realpathSync(root)]; } catch { return [path.resolve(root)]; }
  }))];
  if (!temporaryRoots.some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`))) {
    throw new Error('the isolated home must live under the temporary directory');
  }
  return canonical;
}

/** Resolve the nearest existing ancestor and append the missing components. */
async function realpathOr(target) {
  const suffix = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix.slice().reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a target and require it to stay inside the already-verified isolated
 * home. This is applied to the work directory and the artifact parent before
 * either is created or written.
 */
export async function assertIsolatedTarget(target, root, label) {
  const canonical = await realpathOr(path.resolve(target));
  if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must stay inside the isolated home`);
  }
  return canonical;
}

const ARTIFACT_SEGMENTS = Object.freeze(['storages', 'evolution', 'desktop-tasks', 'task-evidence']);

/**
 * Resolve where the artifact is written.
 *
 * The acceptance path keeps the artifact inside the verified isolated home. An
 * operator may instead designate the channel root of the profile that will read
 * the evidence (`channelHome`): the paired sessions still run against the
 * isolated home, and only the final artifact write crosses into that channel.
 * The kernel validates structure and binding, never provenance, so this opt-in
 * is the operator's own statement that the run is the one it claims to be.
 */
export async function resolveArtifactTarget({ home, taskId, channelHome, outFile } = {}) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new Error('taskId must match the Desktop task identity rule');
  const defaultParent = path.join(home, ...ARTIFACT_SEGMENTS);
  if (channelHome === undefined || channelHome === null) {
    const target = path.resolve(outFile ?? path.join(defaultParent, `${taskId}.json`));
    const parent = await assertIsolatedTarget(path.dirname(target), home, 'artifact directory');
    return { taskId, outFile: path.join(parent, path.basename(target)), channel: null };
  }
  if (typeof channelHome !== 'string' || !path.isAbsolute(channelHome)) throw new Error('channelHome must be an absolute channel root');
  if (outFile !== undefined && outFile !== null) throw new Error('a channel home and an explicit artifact file are two different artifact authorities');
  // Resolve the operator's spelling with the filesystem, not lexically: `hop/..`
  // must follow `hop` before applying `..`, or the evidence would be delivered to
  // whatever directory the folded spelling names.
  const root = await fs.realpath(channelHome).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('the channel home must be an existing directory');
    throw error;
  });
  const info = await fs.stat(root).catch(() => null);
  if (info === null || info.isDirectory() !== true) throw new Error('the channel home must be an existing directory');
  if (root === home || root.startsWith(`${home}${path.sep}`)) throw new Error('the channel home must not be the isolated home');
  return { taskId, outFile: path.join(root, ...ARTIFACT_SEGMENTS, `${taskId}.json`), channel: root };
}

/**
 * A target may be resolved once by the caller and shared with the producer, so
 * the evidence delivery and the operator-report checks cannot disagree about
 * which channel they mean. The shared target is re-verified against its inputs.
 */
export async function assertResolvedArtifactTarget(target, { home, taskId } = {}) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('the artifact target must be a resolved target');
  if (target.taskId !== taskId) throw new Error('the artifact target belongs to a different task id');
  if (target.channel === null) {
    await assertIsolatedTarget(path.dirname(target.outFile), home, 'artifact directory');
    return target;
  }
  if (typeof target.channel !== 'string' || !path.isAbsolute(target.channel)) throw new Error('the artifact target channel must be an absolute path');
  // A shared target must still satisfy the separation rule: a channel inside the
  // isolated home would let the sessions write into the channel they deliver to.
  if (target.channel === home || target.channel.startsWith(`${home}${path.sep}`)) {
    throw new Error('the channel home must not be the isolated home');
  }
  if (typeof target.outFile !== 'string' || path.basename(target.outFile) !== `${taskId}.json`) throw new Error('the artifact target does not name this task');
  if (target.outFile !== path.join(target.channel, ...ARTIFACT_SEGMENTS, `${taskId}.json`)) throw new Error('the artifact target does not match its channel');
  if (await realpathOr(target.channel) !== target.channel) throw new Error('the artifact target channel is not a canonical path');
  return target;
}

/**
 * Walk the artifact path under a designated channel root one component at a
 * time. A recursive mkdir would follow a swapped symlink and create directories
 * outside the channel before the escape is noticed, so existing components are
 * inspected first and only then are missing components created from the root
 * downwards. Returns the verified directory, or null when `create` is false and
 * a component is still missing.
 */
async function resolveChannelDirectory(root, { create }) {
  // The channel root was canonical when the target was resolved, but it can be
  // swapped while the sessions run. A symlinked root must be refused before any
  // mkdir, otherwise the first missing component is created through the link.
  await assertRealDirectory(root, 'the channel home must be a directory');
  // A symlinked *parent* of the root keeps lstat(root) looking like a directory
  // while the path now names another tree: require the canonical path to hold.
  if (await realpathOr(root) !== root) throw new Error('the channel home resolved to a different path');
  let current = root;
  for (const segment of ARTIFACT_SEGMENTS) {
    const next = path.join(current, segment);
    const info = await fs.lstat(next).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (info === null) {
      if (!create) return null;
      await assertRealDirectory(current, 'the artifact directory must stay inside the channel home');
      if (await realpathOr(current) !== current) throw new Error('the artifact directory must stay inside the channel home');
      await fs.mkdir(next, { mode: 0o700 });
      current = next;
      continue;
    }
    if (info.isSymbolicLink()) {
      // A component may be an operator-managed symlink only while it stays in
      // the channel it was given; the artifact never leaves that channel.
      const resolved = await fs.realpath(next);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error('the artifact directory must stay inside the channel home');
      }
      current = resolved;
      continue;
    }
    if (info.isDirectory() !== true) throw new Error('the artifact path under the channel home must be a directory');
    current = next;
  }
  return current;
}

/** `lstat` a real directory (a symlink is not one) or throw the given message. */
async function assertRealDirectory(target, message) {
  const info = await fs.lstat(target).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (info === null || info.isDirectory() !== true) throw new Error(message);
}

/**
 * Resolve a path the way the filesystem does: each component is appended to the
 * already-resolved prefix, so a symlinked component is followed before any later
 * `..` is applied. Lexical folding (`path.resolve`) would instead collapse
 * `hop/..` before following `hop`, and the two spellings can name different
 * files. Missing components have nothing below them, so their remaining parts are
 * appended literally.
 */
export async function resolveFilesystemPath(targetPath, depth = 0) {
  if (depth > 32) throw new Error('the report path follows too many symbolic links');
  // A relative path is joined to the working directory as raw text: resolving it
  // lexically would collapse `hop/..` before `hop` was ever followed.
  const absolute = path.isAbsolute(targetPath) ? targetPath : `${process.cwd()}${path.sep}${targetPath}`;
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter((part) => part !== '' && part !== '.');
  // `a/.\` and a trailing separator ask for a directory; dropping them silently
  // would let a path the filesystem rejects name a file instead.
  const wantsDirectory = absolute.endsWith(path.sep) || path.basename(absolute) === '.';
  let resolved = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '..') {
      // The prefix is already resolved, so its parent is the filesystem parent.
      resolved = path.dirname(resolved);
      continue;
    }
    const next = path.join(resolved, part);
    const info = await fs.lstat(next).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (info === null) {
      // Nothing exists below a missing component, and the filesystem would fail
      // the whole path for a later `..`: refuse instead of folding the path into
      // one that does resolve.
      const remainder = parts.slice(index + 1);
      if (remainder.includes('..')) throw new Error('the report path has a parent reference below a missing directory');
      return path.join(next, ...remainder);
    }
    if (info.isSymbolicLink()) {
      const link = await fs.readlink(next);
      const remainder = parts.slice(index + 1).join(path.sep);
      const joined = path.isAbsolute(link) ? link : `${resolved}${path.sep}${link}`;
      return resolveFilesystemPath(remainder === '' ? joined : `${joined}${path.sep}${remainder}`, depth + 1);
    }
    if (info.isDirectory() !== true && index < parts.length - 1) {
      // A non-directory cannot be traversed: the filesystem fails the whole path
      // (ENOTDIR), and folding `file/..` would name another file.
      throw new Error('the report path passes through a non-directory');
    }
    resolved = next;
  }
  if (wantsDirectory) {
    const info = await fs.lstat(resolved).catch(() => null);
    if (info === null || info.isDirectory() !== true) throw new Error('the report path must name a directory');
  }
  return resolved;
}

/**
 * The report is operator output, never evidence. Compare where a write would
 * actually land, not the spelled path: aliases and symlinks are resolved, and an
 * existing target is compared by identity so a case-variant spelling on a
 * case-insensitive filesystem cannot overwrite the artifact either.
 */
export async function assertReportOutsideEvidence(reportFile, artifactTarget) {
  const artifact = await resolveFilesystemPath(artifactTarget.outFile);
  const report = await resolveFilesystemPath(reportFile);
  const sameFile = async () => {
    const [left, right] = await Promise.all([
      fs.stat(report).catch(() => null),
      fs.stat(artifact).catch(() => null),
    ]);
    return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
  };
  if (report === artifact || await sameFile()) throw new Error('the report must not be written over the task evidence');
  if (artifactTarget.channel === null) return report;
  const channel = await realpathOr(artifactTarget.channel);
  // The whole channel root belongs to the profile that reads the evidence: a
  // report anywhere inside it would be a second write into that profile. The
  // directory identity check also covers a case-variant spelling of an existing
  // channel directory on a case-insensitive filesystem.
  if (report === channel || report.startsWith(`${channel}${path.sep}`) || await isUnderIdentity(report, channel)) {
    throw new Error('the report must stay outside the channel home');
  }
  return report;
}

async function directoryIdentity(target) {
  const info = await fs.stat(target).catch(() => null);
  return info === null ? null : `${info.dev}:${info.ino}`;
}

/** Walk the existing ancestors of `candidatePath` and compare their identity. */
async function isUnderIdentity(candidatePath, directoryPath) {
  const wanted = await directoryIdentity(directoryPath);
  if (wanted === null) return false;
  let current = path.dirname(candidatePath);
  for (;;) {
    if (await directoryIdentity(current) === wanted) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Write the operator report to the exact path the boundary check approved. Using
 * one value for the decision and the write keeps a lexical spelling such as
 * `hop/../<taskId>.json` from being collapsed into the evidence after the check.
 */
export async function writeReportFile(reportFile, artifactTarget, report) {
  const destination = await assertReportOutsideEvidence(reportFile, artifactTarget);
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return destination;
}

/**
 * Read-only preflight, run before any session starts: refuse a target that can
 * never be published into (a channel component that leaves the channel, or a
 * non-directory component) without creating anything outside it first.
 */
export async function inspectArtifactTarget(target) {
  if (target.channel !== null) {
    await resolveChannelDirectory(target.channel, { create: false });
    return;
  }
  const parent = path.dirname(target.outFile);
  const resolved = await realpathOr(parent);
  if (resolved !== parent) throw new Error('the artifact directory resolved to a different path');
}

/**
 * Publish-time preparation: re-validate the target after the long run, create
 * only the directories that are missing under the already-verified root, and
 * return the directory the artifact is written into.
 */
export async function prepareArtifactDirectory(target) {
  if (target.channel === null) {
    const parent = path.dirname(target.outFile);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const resolved = await fs.realpath(parent);
    // The isolated path keeps the historical strict check: no component may
    // redirect the artifact outside the verified home.
    if (resolved !== parent) throw new Error('the artifact directory resolved to a different path after creation');
    return parent;
  }
  const directory = await resolveChannelDirectory(target.channel, { create: true });
  const resolved = await fs.realpath(directory);
  if (resolved !== target.channel && !resolved.startsWith(`${target.channel}${path.sep}`)) {
    throw new Error('the artifact directory must stay inside the channel home');
  }
  return directory;
}

/**
 * The paired sessions write their own state under the isolated home. A storage
 * component that redirects outside it would leak session data into the channel
 * this run is about to deliver evidence to, so the storage roots are pinned to
 * the verified home in both output modes, before any session starts.
 */
export async function assertIsolatedStorageRoots(home) {
  for (const relative of [['storages'], ['storages', 'evolution'], ['storages', 'evolution-experience']]) {
    await assertIsolatedTarget(path.join(home, ...relative), home, `isolated ${relative.join('/')}`);
  }
}

/** Write the artifact atomically; `0600`, and a failed rename leaves no temporary file. */
export async function writeArtifactFile(outFile, artifact) {
  const temporary = `${outFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(temporary, outFile);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Resolve the versions of the Desktop packages that will run the Trial. */
export function readDesktopVersions(binary) {
  const resources = path.join(path.dirname(path.dirname(binary)), 'Resources');
  const anchor = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const root = process.argv[1];
    const dsh = read(path.join(root, 'dsh', 'package.json'));
    const cordis = read(path.join(root, 'cordis', 'package.json'));
    process.stdout.write(JSON.stringify({ dsh: dsh.version, cordis: cordis.version }));
  `;
  const result = spawnSync(binary, ['-e', script, anchor], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`could not read the Desktop package versions: ${(result.stderr || result.stdout || '').slice(-400)}`);
  const parsed = JSON.parse(result.stdout);
  if (typeof parsed?.dsh !== 'string' || typeof parsed?.cordis !== 'string') throw new Error('Desktop package versions are missing');
  return { dsh: parsed.dsh, cordis: parsed.cordis };
}

/**
 * Materialize the candidate Host body as a local preview plugin. The wrapper is
 * not part of the candidate source hash: the Trial mounts the same `host`
 * string, and the artifact binds sha256(host), never this file.
 */
export async function writePreviewModule(file, candidateHost) {
  const source = `// Generated by task-benefit.mjs: preview mount of the exact Trial Host body.
const harness = Object.freeze({
  defineTool: (definition) => definition,
  registerTool: (ctx, tool) => ctx.tools.register(tool),
});
const plugin = Function("harness", ${JSON.stringify(candidateHost)})(harness);
export const name = plugin?.name || "task-benefit-preview";
export const inject = plugin?.inject;
export const provide = plugin?.provide;
export function apply(ctx, config) {
  if (typeof plugin === "function") return plugin(ctx, config);
  if (plugin && typeof plugin.apply === "function") return plugin.apply(ctx, config);
  throw new Error("the candidate Host body returned no apply()");
}
`;
  await fs.writeFile(file, source, { mode: 0o600 });
}

function overlayText(baseURL, previewUrl) {
  const lines = [
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${baseURL}`,
    '    apiKeyEnv: EVOLUTION_ACCEPTANCE_KEY',
    // The experiment must compare the candidate with the same otherwise-empty
    // profile. Promoted plugins from an earlier acceptance would add tools to
    // one side by accident; the fresh-consumer proof is separate.
    '- id: evolution-promoted-consumer',
    '  disabled: true',
  ];
  if (previewUrl) lines.push('- insert:', '    - id: task-benefit-preview', `      name: ${JSON.stringify(previewUrl)}`);
  return `${lines.join('\n')}\n`;
}

function spawnAcp({ cli, home, overlay, env, cwd }) {
  const child = spawn(cli, ['--profile', 'acp', '--patch', overlay], {
    cwd,
    env: { ...env, DSH_HOME: home, EVOLUTION_ACCEPTANCE_KEY: 'local-fixture-only' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-6000); });
  child.stdin.on('error', () => { /* a dead child is reported by the exit handler */ });
  const pending = new Map();
  const updates = [];
  let sequence = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.method === 'session/request_permission') {
      const option = row.params.options.find((candidate) => candidate.kind === 'allow_once');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: row.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })}\n`);
    } else if (row.id !== undefined) pending.get(row.id)?.(row);
    else if (row.method === 'session/update') updates.push(row.params?.update ?? {});
  });
  const rpc = (method, params, timeout = 60_000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${stderr.slice(-800)}`)); }, timeout);
    pending.set(id, (row) => {
      clearTimeout(timer);
      pending.delete(id);
      if (row.error) {
        const error = new Error(`${method}: ${JSON.stringify(row.error)}`);
        // Structured code only; a JSON-RPC numeric code is not an E_ code.
        if (typeof row.error?.data?.code === 'string') error.code = row.error.data.code;
        else if (typeof row.error?.code === 'string') error.code = row.error.code;
        reject(error);
      } else resolve(row.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  child.once('exit', (code, signal) => {
    const detail = `ACP process exited (code ${code}, signal ${signal}); ${stderr.slice(-800)}`;
    for (const [, settle] of pending) settle({ error: { code: -32000, message: detail } });
    pending.clear();
  });
  return { child, rpc, updates, stderr: () => stderr };
}

async function runSession({ cli, home, work, overlay, env, bridge, prompt, label, side, expectedTokens, expectedReads = null, candidateTool }) {
  const startedAt = Date.now();
  const acp = spawnAcp({ cli, home, overlay, env, cwd: home });
  let promptFailure = null;
  const before = bridge.turns.length;
  const updates = acp.updates;
  try {
    await acp.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await acp.rpc('session/new', { cwd: home, mcpServers: [] });
    await acp.rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] }, DEFAULT_TIMEOUT_MS);
  } catch (error) {
    promptFailure = error;
  } finally {
    try { acp.child.stdin.end(); } catch {}
    try { acp.child.kill('SIGTERM'); } catch {}
    await Promise.race([once(acp.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  const durationMs = Date.now() - startedAt;
  const turns = bridge.turns.slice(before);
  const assistantText = updates
    .filter((update) => update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text')
    .map((update) => update.content.text).join('');
  const row = extractSessionEvidence({ label, side, turns, updates, assistantText, expectedTokens, expectedReads, cwd: home, candidateTool, durationMs });
  const failedTurns = turns.filter((turn) => turn.ok !== true).length;
  const failureReasons = pilotFailureReasons(turns);
  // The raw transport detail stays on the operator console; the persisted row
  // carries only a stage/category/code projection.
  if (promptFailure !== null) console.error(`[task-benefit] ${label} failed: ${String(promptFailure?.message ?? promptFailure).slice(0, 400)}`);
  return {
    ...row,
    ok: promptFailure === null && failedTurns === 0 && row.turns > 0 && row.usageComplete === true && row.attributionComplete === true,
    failedTurns,
    retryableTransportFailure: promptFailure === null && pilotTransportRetryable(turns),
    ...(failureReasons.length > 0 ? { failureReasons } : {}),
    ...(promptFailure === null ? {} : { failure: failureProjection(promptFailure) }),
    assistantCharacters: assistantText.length,
  };
}

/** Multi-file context-policy evidence needs a complete path-to-value mapping. */
export function assertReadBinding(improvement, task) {
  if (improvement === 'context-policy' && task.tokens.length > 1 && task.reads.length === 0) {
    throw new Error('a multi-file context-policy task must declare task.reads');
  }
}

/**
 * Run the complete paired experiment and write the artifact.
 *
 * The order alternates candidate-first and baseline-first so a shared cache or
 * provider warm-up cannot be attributed to one side. Each session is a fresh
 * ACP process, just like a new production session.
 */
export async function produceTaskBenefit(options = {}) {
  const home = assertIsolatedHome(options.home);
  const work = await assertIsolatedTarget(options.work ?? path.join(home, 'task-benefit-work'), home, 'work directory');
  const task = normalizeTask(options.task);
  const improvement = options.improvement ?? 'context-policy';
  assertReadBinding(improvement, task);
  const taskId = options.taskId;
  const candidateHost = options.candidateHost;
  if (typeof candidateHost !== 'string' || candidateHost.trim() === '') throw new Error('candidateHost must be the exact Host body');
  if (!['tool', 'context-policy'].includes(improvement)) throw new Error('improvement must be tool or context-policy');
  const targetTool = typeof options.targetTool === 'string' ? options.targetTool : null;
  if (improvement === 'tool' && targetTool === null) throw new Error('a tool-form run needs targetTool');
  const runs = Number.isInteger(options.runs) ? options.runs : TASK_BENEFIT_RUNS.min;
  if (runs < TASK_BENEFIT_RUNS.min || runs > TASK_BENEFIT_RUNS.max) throw new Error(`runs must be ${TASK_BENEFIT_RUNS.min}-${TASK_BENEFIT_RUNS.max}`);
  const model = typeof options.model === 'string' && options.model ? options.model : TASK_BENEFIT_MODEL;
  // The target decides the artifact identity, so it is resolved (and the
  // isolated storage roots are pinned) before the Desktop binary is even read.
  // A caller may share one resolved target with the producer, so the evidence
  // delivery and any other check of the same run agree on the channel even when
  // an alias is re-pointed between their resolutions.
  const artifactTarget = await assertResolvedArtifactTarget(
    options.artifactTarget ?? await resolveArtifactTarget({
      home,
      taskId,
      channelHome: options.channelHome,
      outFile: options.outFile,
    }),
    { home, taskId },
  );
  await assertIsolatedStorageRoots(home);
  await inspectArtifactTarget(artifactTarget);
  const outFile = artifactTarget.outFile;
  const host = options.host ?? readDesktopVersions(options.binary ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness');
  const cli = options.cli ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_')));
  delete env.ELECTRON_RUN_AS_NODE;
  await fs.mkdir(work, { recursive: true });
  if (await fs.realpath(work) !== work) throw new Error('the work directory resolved to a different path after creation');
  // A fresh run directory under the verified work root: pre-existing
  // bridge-cwd, preview or overlay symlinks cannot be followed.
  const runWork = await fs.mkdtemp(path.join(work, 'run-'));
  if (await fs.realpath(runWork) !== runWork) throw new Error('the fresh run directory resolved to a different path');
  await fs.mkdir(path.join(runWork, 'bridge-cwd'), { recursive: true });
  await inspectArtifactTarget(artifactTarget);

  const previewUrl = pathToFileURL(path.join(runWork, 'preview-policy.mjs')).href;
  await writePreviewModule(path.join(runWork, 'preview-policy.mjs'), candidateHost);
  // The bridge bounds each tool result before asking the pilot model, because a
  // provider transcript is not unlimited. A scenario whose real result is larger
  // than that default must raise the bound explicitly, or the model would be
  // deciding on a harness-truncated result instead of the host's own output.
  const maxToolText = Number.isInteger(options.maxToolText) && options.maxToolText > 0
    ? options.maxToolText : undefined;
  const bridge = await startModelBridge({
    model,
    cwd: path.join(runWork, 'bridge-cwd'),
    isolatePilotTools: true,
    ...(maxToolText ? { maxToolText } : {}),
  });
  let candidateOverlay;
  let baselineOverlay;
  const sessions = { baseline: [], candidate: [] };
  // An incomplete pilot session is not a measurement. Keep its row in the
  // report and replace it once with a fresh session when the only failure was
  // the pilot transport (no product tool failure). The artifact still requires
  // every final session to be complete and correct.
  const sessionRetries = [];
  try {
    candidateOverlay = path.join(runWork, 'overlay-candidate.yml');
    baselineOverlay = path.join(runWork, 'overlay-baseline.yml');
    await fs.writeFile(candidateOverlay, overlayText(bridge.baseURL, previewUrl), { mode: 0o600 });
    await fs.writeFile(baselineOverlay, overlayText(bridge.baseURL, null), { mode: 0o600 });
    for (let repetition = 0; repetition < runs; repetition += 1) {
      const order = repetition % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const side of order) {
        const label = `${side}-${repetition + 1}`;
        const attempts = [await runSession({
          cli, home, work: runWork,
          overlay: side === 'candidate' ? candidateOverlay : baselineOverlay,
          env, bridge, prompt: task.prompt,
          label, side,
          expectedTokens: task.tokens,
          expectedReads: task.reads,
          candidateTool: improvement === 'tool' ? targetTool : null,
        })];
        // Only a confirmed pilot transport failure is replaced; a product tool
        // failure or an own-tool bypass keeps its row and invalidates the artifact.
        if (retryableSession(attempts[0])) {
          const retried = await runSession({
            cli, home, work: runWork,
            overlay: side === 'candidate' ? candidateOverlay : baselineOverlay,
            env, bridge, prompt: task.prompt,
            label: label + '-retry', side,
            expectedTokens: task.tokens,
            expectedReads: task.reads,
            candidateTool: improvement === 'tool' ? targetTool : null,
          });
          attempts.push(retried);
        }
        const row = attempts.at(-1);
        sessions[side].push(row);
        if (attempts.length > 1) {
          sessionRetries.push({
            side,
            repetition: repetition + 1,
            attempts: attempts.map((attempt) => ({
              label: attempt.label,
              ok: attempt.ok,
              failedTurns: attempt.failedTurns,
              toolFailures: attempt.toolFailures,
              ...(attempt.failureReasons ? { failureReasons: attempt.failureReasons } : {}),
              tokens: attempt.tokens,
              durationMs: attempt.durationMs,
            })),
          });
        }
        options.log?.(`${side} session ${repetition + 1}: correct=${row.correct} turns=${row.turns} calls=${row.toolCalls} tokens=${row.tokens} exercised=${row.exercised} ms=${row.durationMs}${attempts.length > 1 ? ' (retried)' : ''}`);
      }
    }
  } finally {
    await bridge.close();
  }

  const complete = [...sessions.baseline, ...sessions.candidate].every((row) => row.ok === true);
  const artifact = buildTaskBenefitArtifact({
    taskId,
    task,
    candidateHost,
    model,
    host,
    runs,
    baseline: sessions.baseline,
    candidate: sessions.candidate,
    adoption: improvement === 'tool'
      ? { sessionsUsingCandidate: sessions.candidate.filter((row) => row.usedCandidate).length, sessionsExercised: 0 }
      : { sessionsUsingCandidate: 0, sessionsExercised: sessions.candidate.filter((row) => row.exercised).length },
  });
  if (!complete) artifact.complete = false;
  // Re-validate after the long run and write through the directory the
  // publish-time check proved: the target may have changed while sessions ran.
  const artifactDirectory = await prepareArtifactDirectory(artifactTarget);
  await writeArtifactFile(path.join(artifactDirectory, path.basename(outFile)), artifact);
  const report = {
    kind: 'dsh-evolution-task-benefit-run',
    ok: complete,
    taskId,
    task: { id: task.id, promptSha256: sha256(task.prompt), expectSha256: sha256(task.expect) },
    candidateHostSha256: sha256(candidateHost),
    improvement,
    targetTool,
    model,
    host,
    runs,
    tokenBasis: 'model-bill: input + output + cache.read (opencode reports each decision turn)',
    artifact: {
      complete,
      baseline: artifact.baseline,
      candidate: artifact.candidate,
      adoption: artifact.adoption,
    },
    sessions,
    retries: sessionRetries,
    artifactFile: outFile,
  };
  return { ok: complete, artifact, report, artifactFile: outFile };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function argument(name, argv) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

if (process.argv[1] && process.argv[1].endsWith('task-benefit.mjs')) {
  const argv = process.argv.slice(2);
  const home = argument('--home', argv);
  const taskFile = argument('--task', argv);
  const hostFile = argument('--candidate-host', argv);
  if (!home || !taskFile || !hostFile) {
    throw new Error('usage: task-benefit.mjs --home <isolated-dsh-home> --task <task.json> --candidate-host <host.js> [--task-id <id>] [--runs 3-5] [--out <artifact.json>] [--report <report.json>] [--channel-home <dsh-home-that-reads-the-evidence>]');
  }
  // An option that is present but has no value must not silently fall back to
  // the default: `--channel-home` at the end of the command would otherwise run
  // the paired sessions and deliver nothing.
  const option = (name) => {
    if (!argv.includes(name)) return undefined;
    const value = argument(name, argv);
    if (value === null || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  const channelHome = option('--channel-home');
  const taskId = option('--task-id') ?? `producer-${Date.now().toString(36)}`;
  const outFile = option('--out');
  const reportFile = option('--report');
  // The report is operator output, not evidence: it must never overwrite the
  // artifact the Desktop host reads for this task.
  let artifactTarget = null;
  if (reportFile !== undefined) {
    artifactTarget = await resolveArtifactTarget({
      home: assertIsolatedHome(home),
      taskId,
      channelHome,
      outFile,
    });
    await assertReportOutsideEvidence(reportFile, artifactTarget);
  }
  const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const candidateHost = await fs.readFile(hostFile, 'utf8');
  const result = await produceTaskBenefit({
    home,
    task,
    taskId,
    candidateHost,
    runs: Number(argument('--runs', argv) ?? TASK_BENEFIT_RUNS.min),
    model: argument('--model', argv) ?? TASK_BENEFIT_MODEL,
    // The report preflight, the evidence delivery and the report re-check share
    // this one resolved target.
    ...(artifactTarget === null ? { outFile, channelHome } : { artifactTarget }),
    log: (line) => console.log(line),
  });
  if (reportFile) {
    // Re-check after the long run: the paths may have been re-pointed while the
    // sessions ran, and the report must not overwrite the delivered evidence.
    // The write goes to the exact path that check approved.
    await writeReportFile(reportFile, artifactTarget, result.report);
  }
  console.log(JSON.stringify({ ok: result.ok, artifact: result.artifactFile, baseline: result.artifact.baseline, candidate: result.artifact.candidate }, null, 2));
}
