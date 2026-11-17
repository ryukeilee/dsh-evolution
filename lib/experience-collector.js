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
      const target = `tool:${exec.name}`;
      const counter = outcomeFor(target);
      counter.attempts += 1;
      if (!result?.isError) { counter.successes += 1; return; }
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
