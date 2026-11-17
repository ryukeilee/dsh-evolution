import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { openSharedExperience, experienceEventId } from './shared-experience.js';
import { resolveEvolutionPaths } from './evolution-paths.js';
import { finalizeExperienceRecall } from './experience-recall.js';
import { safeErrorDto, warnRedacted, redactedToolError, toolFailureCode } from './error-boundary.js';

export const name = 'dsh-evolution-experience';
export const inject = ['tools'];

// Re-exported from the shared boundary so existing callers keep this import path;
// the autonomous observer reads the same implementation from error-boundary.js.
export { toolFailureCode };

// A non-error degradation has no failure code and must not enter the failure
// denominator. Only the structured outcome is classified; no tool output is
// copied into the store.
const TRUNCATED_LINE = /\.\.\. \(line truncated to \d+ chars\)$/;
const OUTPUT_CAPPED = /\(Output capped\. Showing lines /;
const MAX_PENDING_AGENTS = 64;
const MAX_PENDING_PER_AGENT = 8;

/** Classify one successful result as a known non-error degradation, if any. */
export function detectDegradation(exec, result) {
  if (!exec || !result || result.isError === true || exec.name !== 'read') return null;
  const value = result.value;
  if (value && typeof value === 'object' && Array.isArray(value.lines)) {
    for (const line of value.lines.slice(0, 2050)) {
      if (typeof line?.text === 'string' && TRUNCATED_LINE.test(line.text)) return { target: 'tool:read', kind: 'line-truncated' };
    }
  }
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (typeof block?.text !== 'string') continue;
    const tail = block.text.length > 8192 ? block.text.slice(-8192) : block.text;
    if (OUTPUT_CAPPED.test(tail)) return { target: 'tool:read', kind: 'output-capped' };
  }
  return null;
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
  const flushDegradations = (agentId, recoveryTool, recoveryCalls) => {
    const list = pending.get(agentId);
    if (!list) return;
    pending.delete(agentId);
    const calls = recoveryCalls === 1 ? 1 : 0;
    // One observed recovery call belongs to the degradation group, not to each
    // degradation event: three truncated reads recovered by one shell call are
    // one call of cost, not three.
    list.forEach((item, index) => {
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
  const deferDegradation = (agentId, item) => {
    if (!pending.has(agentId) && pending.size >= MAX_PENDING_AGENTS) flushDegradations(pending.keys().next().value, null, 0);
    const list = pending.get(agentId) ?? [];
    list.push(item);
    pending.set(agentId, list);
    if (list.length > MAX_PENDING_PER_AGENT) flushDegradations(agentId, null, 0);
  };
  const outcomeFor = (target) => {
    let row = outcomes.get(target);
    if (row) outcomes.delete(target);
    else {
      if (outcomes.size >= MAX_TRACKED_TARGETS) outcomes.delete(outcomes.keys().next().value);
      row = { attempts: 0, successes: 0 };
    }
    outcomes.set(target, row);
    return row;
  };
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec?.agent || String(exec.name || '').startsWith('evolution_')) return;
      // The same host execution object may be delivered more than once. Count it
      // once, before the failure path takes its id, so a repeated delivery cannot
      // inflate the denominator.
      if (counted.has(exec)) return;
      counted.add(exec);
      // A degradation is recovered by the first call to a *different* tool, or
      // by a same-tool call whose result is no longer degraded. Later reads of
      // other files are the task continuing, not nine separate recoveries; the
      // group shares one observed recovery call per turn.
      const degraded = result?.isError ? null : detectDegradation(exec, result);
      const pendingForAgent = pending.get(exec.agent.id);
      const sameTarget = Array.isArray(pendingForAgent) && pendingForAgent.length > 0
        && pendingForAgent[0].target === `tool:${exec.name}`;
      if (Array.isArray(pendingForAgent) && pendingForAgent.length > 0 && (!sameTarget || degraded === null)) {
        flushDegradations(exec.agent.id, exec.name, 1);
      }
      const target = `tool:${exec.name}`;
      const counter = outcomeFor(target);
      counter.attempts += 1;
      if (!result?.isError) {
        counter.successes += 1;
        if (degraded !== null) {
          const id = typeof exec.callId === 'string' && exec.callId !== ''
            ? experienceEventId('degradation', exec.agent.id, exec.callId, degraded.kind)
            : experienceEventId('degradation', exec.agent.id, randomUUID());
          deferDegradation(exec.agent.id, { id, ...degraded });
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
    } catch (error) { warnRedacted(ctx, 'experience collection failed', error); }
  });
  ctx.on('agent/error', payload => {
    try {
      if (!payload?.agent) return;
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
      if (typeof agentId === 'string' && agentId !== '') flushDegradations(agentId, null, 0);
    } catch (error) { warnRedacted(ctx, 'experience degradation flush failed', error); }
  });
  ctx.on('agent/disposed', payload => {
    try {
      const agentId = payload?.agent?.id;
      if (typeof agentId === 'string' && agentId !== '') flushDegradations(agentId, null, 0);
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
