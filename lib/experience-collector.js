import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { openSharedExperience, experienceEventId } from './shared-experience.js';
import { resolveEvolutionPaths } from './diagnostics.js';
import { finalizeExperienceRecall } from './experience-recall.js';
import { safeErrorDto } from './orchestrator.js';
import { warnRedacted, redactedToolError } from './registration.js';

export const name = 'dsh-evolution-experience';
export const inject = ['tools'];

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
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!result?.isError || !exec?.agent || String(exec.name || '').startsWith('evolution_')) return;
      if (typeof exec.callId !== 'string' || !exec.callId || typeof exec.agent.id !== 'string') throw new Error('E_EXPERIENCE_TOOL_ID');
      // callId belongs to a model response, not to the whole Session. A new
      // real execution may reuse it. Dedup repeated delivery of the same host
      // execution object, while counting a newly executed call separately.
      let id = executions.get(exec);
      if (!id) { id = experienceEventId('tool', exec.agent.id, exec.callId, randomUUID()); executions.set(exec, id); }
      store.recordFailure({ id,
        type: 'tool/error', code: result.code, target: `tool:${exec.name}` });
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
