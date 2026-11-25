import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { openSharedExperience, experienceEventId } from './shared-experience.js';
import { resolveEvolutionPaths } from './evolution-paths.js';
import { finalizeExperienceRecall } from './experience-recall.js';
import { safeErrorDto, warnRedacted, redactedToolError, toolFailureCode } from './error-boundary.js';
import { isVerificationCall } from './verification-call.js';

export const name = 'dsh-evolution-experience';
export const inject = ['tools'];

// Re-exported from the shared boundary so existing callers keep this import path;
// the autonomous observer reads the same implementation from error-boundary.js.
export { toolFailureCode };

// A non-error degradation has no failure code and must not enter the failure
// denominator. Only the structured outcome is classified; no tool output is
// copied into the store.
const TRUNCATED_LINE = /\.\.\. \(line truncated to \d+ chars\)$/;
// Only the official renderer's end-of-file footer counts; normal file text may
// contain the same words anywhere else in the content.
const OUTPUT_CAPPED = /\(Output capped\. Showing lines \d+-\d+\. Use offset=\d+ to continue\.\)\n<\/content>$/;
const MAX_PENDING_AGENTS = 64;
const MAX_PENDING_PER_AGENT = 8;
// These are possible fallback reads. A successful run_code result only reports
// that the program completed. In PTC it can be the envelope of the very read
// that lost data. A fallback tool called through the PTC SDK reports its own result.
const RECOVERY_TOOLS = new Set(['bash', 'grep']);
// The kernel excludes cancelled runs from durable failure memory. A lightweight
// collector that records them would turn three user cancellations into a
// phantom environment candidate, so the same two official abort codes are
// filtered here. `exec.signal.aborted` is the primary proof; the code is the
// fallback for transports that do not carry the signal on the receipt.
const ABORTED_RESULT_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH']);
// A failure episode needs this many consecutive clean successes before a
// recovery is durable. It matches `MIN_RATE_SAMPLES` in experience-plan.js:
// below five samples the observed window is too noisy to replace the all-time
// failure signal with a resolution. Successes that still lost data are not
// clean and are excluded from this counter (the `successes` window keeps
// counting every success, unchanged).
export const RECOVERY_SUCCESS_THRESHOLD = 5;

/** Classify one successful result as a known non-error degradation, if any. */
export function detectDegradation(exec, result) {
  if (!exec || !result || result.isError === true || exec.name !== 'read') return null;
  const value = result.value;
  if (value && typeof value === 'object' && Array.isArray(value.lines)) {
    for (const line of value.lines.slice(0, 2050)) {
      if (typeof line?.text === 'string' && TRUNCATED_LINE.test(line.text)) {
        return { target: 'tool:read', kind: 'line-truncated', path: typeof value.path === 'string' ? value.path : null };
      }
    }
  }
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (typeof block?.text !== 'string') continue;
    const tail = block.text.length > 8192 ? block.text.slice(-8192) : block.text;
    if (OUTPUT_CAPPED.test(tail)) return { target: 'tool:read', kind: 'output-capped', path: typeof value?.path === 'string' ? value.path : null };
  }
  return null;
}

/**
 * A different-tool recovery must be a real success. The official bash tool
 * reports a non-zero foreground exit with `isError: false`, so its structured
 * receipt decides; a timeout, abort or signal is never a recovery.
 */
function recoverySucceeded(exec, result) {
  if (!result || result.isError === true) return false;
  if (exec?.name !== 'bash') return true;
  const value = result.value;
  if (!value || typeof value !== 'object') return false;
  if (value.timedOut === true || value.aborted === true) return false;
  if (typeof value.signal === 'string' && value.signal !== '') return false;
  return typeof value.exitCode === 'number' && value.exitCode === 0;
}

class ExperienceService extends Service {
  constructor(ctx, store) { super(ctx, 'evolutionExperience'); this.store = store; }
}

/** Synchronous COMMIT is the receipt boundary. The official emit does not await
 * listeners, so a detached promise cannot promise persistence on process exit.
 * Only failure metadata crosses this boundary; arguments, results, transcript,
 * provider error text and session options are never copied into the store.
 */
export function apply(ctx, config = {}) {
  const { dshHome } = resolveEvolutionPaths(config);
  const store = openSharedExperience(config.experienceRoot || path.join(dshHome, 'storages', 'evolution-experience'));
  ctx.effect(() => () => store.close());
  new ExperienceService(ctx, store);
  const errors = new WeakMap();
  const executions = new WeakMap();
  // Bounded per-target attempt/success counters. A recorded failure carries the
  // attempts and successes observed since that target's previous failure, so the
  // planner gets a real denominator without writing one row per successful call.
  // The map is capped and re-inserted on every touch, so it is a small LRU and
  // can never grow with the session length.
  const MAX_TRACKED_TARGETS = 256;
  const outcomes = new Map();
  const counted = new WeakSet();
  // Degradations are recorded with the recovery call that followed them, which
  // is the only cost signal the tool stream exposes. Pending entries are
  // per-agent and bounded; a turn that ends without a further call records the
  // loss with no observed recovery instead of guessing one.
  const pending = new Map();
  const settleDegradations = (agentId, predicate, recoveryTool, recoveryCalls) => {
    const list = pending.get(agentId);
    if (!list) return;
    const matched = [];
    const rest = [];
    for (const item of list) (predicate(item) ? matched : rest).push(item);
    if (matched.length === 0) return;
    if (rest.length > 0) pending.set(agentId, rest);
    else pending.delete(agentId);
    const calls = recoveryCalls === 1 ? 1 : 0;
    // One observed recovery call belongs to the degradation group, not to each
    // degradation event: three truncated reads recovered by one shell call are
    // one call of cost, not three.
    matched.forEach((item, index) => {
      try {
        store.recordDegradation({
          id: item.id,
          target: item.target,
          kind: item.kind,
          recoveryTool,
          recoveryCalls: calls === 1 && index === 0 ? 1 : 0,
        });
      } catch (error) { warnRedacted(ctx, 'experience degradation collection failed', error); }
    });
  };
  const flushAllDegradations = (agentId, recoveryTool, recoveryCalls) => {
    settleDegradations(agentId, () => true, recoveryTool, recoveryCalls);
  };
  const deferDegradation = (agentId, item) => {
    if (!pending.has(agentId) && pending.size >= MAX_PENDING_AGENTS) flushAllDegradations(pending.keys().next().value, null, 0);
    const list = pending.get(agentId) ?? [];
    list.push(item);
    pending.set(agentId, list);
    if (list.length > MAX_PENDING_PER_AGENT) flushAllDegradations(agentId, null, 0);
  };
  const outcomeFor = (target) => {
    let row = outcomes.get(target);
    if (row) outcomes.delete(target);
    else {
      if (outcomes.size >= MAX_TRACKED_TARGETS) outcomes.delete(outcomes.keys().next().value);
      row = { attempts: 0, successes: 0, recoverySuccesses: 0, lastFailure: null, recoveryRecorded: false };
    }
    outcomes.set(target, row);
    return row;
  };
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec?.agent || isVerificationCall(exec) || String(exec.name || '').startsWith('evolution_')) return;
      // The same host execution object may be delivered more than once. Count it
      // once, before the failure path takes its id, so a repeated delivery cannot
      // inflate the denominator.
      if (counted.has(exec)) return;
      counted.add(exec);
      // A cancelled call is not a failure of the tool and cannot prove recovery
      // of a pending degradation either. The official loop emits no
      // `agent/turn-stopping` and no `agent/error` on cancellation, but it does
      // publish aborted tool results; that is the last per-agent turn boundary
      // observable from the tool stream, so close any pending loss here with the
      // unrecovered outcome before dropping the result.
      if (exec?.signal?.aborted === true || ABORTED_RESULT_CODES.has(toolFailureCode(result))) {
        const agentId = exec?.agent?.id;
        if (typeof agentId === 'string' && agentId !== '') flushAllDegradations(agentId, null, 0);
        return;
      }
      // A degradation is recovered by a *successful* read/data call that can be
      // associated with it: a same-path successful re-read, or a successful
      // bash/grep while the loss is pending in the same PTC root (or on the
      // native path, where there is no PTC root). A same-path re-read has
      // independent correlation and can cross roots.
      const ptcRoot = exec.rootCallId && exec.rootCallId !== exec.callId ? exec.rootCallId : null;
      const degraded = result?.isError ? null : detectDegradation(exec, result);
      const pendingForAgent = pending.get(exec.agent.id);
      const sameTarget = Array.isArray(pendingForAgent) && pendingForAgent.length > 0
        && pendingForAgent[0].target === `tool:${exec.name}`;
      let settle = null;
      if (Array.isArray(pendingForAgent) && pendingForAgent.length > 0) {
        if (!sameTarget) {
          if (RECOVERY_TOOLS.has(exec.name) && recoverySucceeded(exec, result)) {
            settle = { predicate: (item) => item.ptcRoot === ptcRoot, tool: exec.name };
          }
        } else if (degraded === null && result?.isError !== true) {
          const currentPath = result?.value && typeof result.value === 'object' ? result.value.path : null;
          if (typeof currentPath === 'string' && currentPath !== '') settle = { predicate: (item) => item.path === currentPath, tool: exec.name };
        }
      }
      if (settle !== null) settleDegradations(exec.agent.id, settle.predicate, settle.tool, 1);
      const target = `tool:${exec.name}`;
      const counter = outcomeFor(target);
      counter.attempts += 1;
      if (!result?.isError) {
        counter.successes += 1;
        // Only a clean success proves recovery: a successful call that still
        // lost data is a degradation, not evidence the failure was fixed. The
        // official bash tool reports a failed foreground command with
        // isError:false and a non-zero exitCode, so its structured receipt must
        // decide too. The `successes` denominator above keeps counting every
        // success, unchanged.
        const clean = degraded === null
          && (exec.name !== 'bash' || recoverySucceeded(exec, result));
        if (clean) {
          counter.recoverySuccesses += 1;
          // The planner only accepts a recovery strictly newer than the latest
          // failure. A recovery committed in the failure's own millisecond can
          // never satisfy that rule, so keep counting clean successes but do not
          // spend the episode: a later-millisecond success writes the same fact
          // with the same stable event id, and repeated successes still write
          // nothing once the recovery is recorded.
          if (counter.lastFailure && !counter.recoveryRecorded
            && counter.recoverySuccesses >= RECOVERY_SUCCESS_THRESHOLD
            && Date.now() > counter.lastFailure.at) {
            store.recordToolRecovery({ id: experienceEventId('recovery', target, counter.lastFailure.id), target });
            counter.recoveryRecorded = true;
          }
        } else {
          // A degraded success (or a failed bash receipt) breaks the streak:
          // the next clean successes must be consecutive before a recovery is
          // durable.
          counter.recoverySuccesses = 0;
        }
        if (degraded !== null) {
          // The official host reuses a callId across separate execution objects
          // (PTC envelopes). Without a per-execution random part a second real
          // degradation with a different recovery result conflicts on the same
          // event id and is silently swallowed. Match the failure path, which
          // already includes randomUUID() unconditionally.
          const id = experienceEventId('degradation', exec.agent.id,
            typeof exec.callId === 'string' && exec.callId !== '' ? exec.callId : '', randomUUID());
          deferDegradation(exec.agent.id, { id, ...degraded, ptcRoot });
        }
        return;
      }
      if (typeof exec.callId !== 'string' || !exec.callId || typeof exec.agent.id !== 'string') throw new Error('E_EXPERIENCE_TOOL_ID');
      let id = executions.get(exec);
      if (!id) { id = experienceEventId('tool', exec.agent.id, exec.callId, randomUUID()); executions.set(exec, id); }
      const failureCode = toolFailureCode(result);
      const metrics = { attemptsSinceFailure: counter.attempts, successesSinceFailure: counter.successes };
      // Reset only after the commit: a rejected write keeps the window for the
      // next failure instead of silently dropping it.
      store.recordFailure({ id,
        type: 'tool/error', code: failureCode, target, metrics });
      counter.attempts = 0;
      counter.successes = 0;
      // A new failure starts a new episode: the previous recovery (if any) no
      // longer resolves this target, and the next clean successes can write a
      // fresh recovery fact with a distinct id.
      counter.recoverySuccesses = 0;
      // Captured after the commit, so a recovery must land in a strictly later
      // millisecond to be durable (the planner applies the same strict rule).
      counter.lastFailure = { id, code: failureCode, at: Date.now() };
      counter.recoveryRecorded = false;
    } catch (error) { warnRedacted(ctx, 'experience collection failed', error); }
  });
  ctx.on('agent/error', payload => {
    try {
      if (!payload?.agent) return;
      // The official agent loop emits `agent/turn-stopping` only on a normal
      // turn end; an abort or error ends the turn without it. Any degradation
      // still pending would otherwise be settled by an unrelated success in a
      // later turn on the same agent and reported as recovered. Close the turn
      // here, before recording the agent failure, with the unrecovered outcome.
      const agentId = payload.agent.id;
      if (typeof agentId === 'string' && agentId !== '') flushAllDegradations(agentId, null, 0);
      const error = payload.error;
      const identityObject = payload;
      let id = errors.get(identityObject);
      if (!id) { id = experienceEventId('agent', payload.agent.id, randomUUID()); errors.set(identityObject, id); }
      const detail = safeErrorDto(error, 'observation');
      store.recordFailure({ id, type: 'agent/error', code: detail.errorCode, target: 'agent' });
    } catch (error) { warnRedacted(ctx, 'experience collection failed', error); }
  });
  ctx.on('agent/turn-stopping', payload => {
    try {
      const agentId = payload?.agent?.id;
      if (typeof agentId === 'string' && agentId !== '') flushAllDegradations(agentId, null, 0);
    } catch (error) { warnRedacted(ctx, 'experience degradation flush failed', error); }
  });
  ctx.on('agent/disposed', payload => {
    try {
      const agentId = payload?.agent?.id;
      if (typeof agentId === 'string' && agentId !== '') flushAllDegradations(agentId, null, 0);
    } catch (error) { warnRedacted(ctx, 'experience degradation flush failed', error); }
  });
  return store;
}

// A separate optional loader entry owns the lightweight tool. Selecting it
// never replaces the collector's user configuration or opens another store.
export function registerHistoryTool(ctx, store) {
  ctx.tools.register({
    name: 'evolution_history',
    description: 'Read shared experience. With query, return bounded advisory recall; without query, return committed counts. No Trial or production actions.',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, target: { type: 'string' }, limit: { type: 'number' },
      collection: { type: 'string' }, impactScope: { type: 'array', items: { type: 'string' } },
    } },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args = {}) {
      try {
        if (!args.query) return { collection: 'shared-experience', ...store.stats() };
        const input = { problem: args.query, target: args.target, impactScope: args.impactScope };
        const options = { limits: { maxEntries: args.limit } };
        return finalizeExperienceRecall(input, [store.recall(input, options)], options);
      } catch (error) { throw redactedToolError(error, 'experience-recall'); }
    },
  });
}
