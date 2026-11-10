/** Runs inside a real entry through its official loader. Never emits synthetic
 * telemetry: invokes the real tool pipeline on a nonexistent fixture file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPromotionProbe } from './promotion-probe.mjs';

export const inject = ['agents', 'tools', 'agentPresets', 'evolutionExperience'];
export function apply(ctx) {
  const output = process.env.EVOLUTION_ENTRY_PROBE_OUT;
  if (!output) throw new Error('Isolated probe output required');
  const timer = setTimeout(() => {
    void run().then(result => fs.writeFileSync(output, JSON.stringify({ ok: true, ...result }, null, 2)),
      error => fs.writeFileSync(output, JSON.stringify({ ok: false, error: error.message }, null, 2)));
  }, 1000);
  ctx.effect(() => () => clearTimeout(timer));
  async function run() {
    const cwd = process.env.DSH_HOME;
    const store = ctx.evolutionExperience.store;
    let before = store.stats();
    const core = ctx.get('evolution')?.orchestrator;
    const experimentsBefore = core?.experiments.size ?? 0;
    const parent = await ctx.agents.create({ sessionId: `entry-parent-${randomUUID()}`, meta: { cwd },
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx); } });
    const startup = core && process.env.EVOLUTION_ENTRY_PROBE_VERIFY_STARTUP === '1'
      ? await core.verifyStartupCanary(parent.agent) : null;
    if (startup) before = store.stats();
    const child = await ctx.agents.create({ sessionId: `entry-child-${randomUUID()}`, parentAgent: parent.agent,
      meta: { cwd, parentSession: parent.agent.id, origin: 'subagent' },
      setup: agentCtx => { ctx.agentPresets.composeFrom(agentCtx, parent.agent.ctx); } });
    let evidence;
    try {
      const read = ctx.tools.schemas(parent.agent).find(tool => /read.*file|file.*read|^read$/.test(tool.name));
      if (!read) throw new Error('Official file reading tool missing');
      const definition = ctx.tools.get(read.name, parent.agent);
      const args = Object.fromEntries(Object.keys(definition.parameters.properties || {}).filter(key => /path/.test(key))
        .map(key => [key, path.join(cwd, 'entry-probe-missing.txt')]));
      const call = async (agent, id) => ctx.tools.execute({ agent, signal: new AbortController().signal,
        calls: [{ type: 'tool_call', id, name: read.name, arguments: JSON.stringify(args) }] });
      await call(parent.agent, 'parent-read');
      const afterParent = store.stats();
      await call(parent.agent, 'parent-read');
      const afterRepeatCallId = store.stats();
      await call(child.agent, 'child-read');
      const afterChild = store.stats();
      if (afterParent.events !== before.events + 1 || afterRepeatCallId.events !== before.events + 2
        || afterChild.events !== before.events + 3) throw new Error('Root/child collection or reused callId mismatch');
      const history = ctx.tools.get('evolution_history', parent.agent);
      const query = core ? { query: 'agent', target: 'agent' } : { query: read.name, target: `tool:${read.name}` };
      const recalled = await history.execute(query, { agent: parent.agent, signal: new AbortController().signal });
      if (!recalled.sources.some(source => source.source === 'shared-knowledge' && source.available)) throw new Error('Shared history unavailable');
      if ((core?.experiments.size ?? 0) !== experimentsBefore) throw new Error('Daily failure started an experiment');
      evidence = { node: process.version, simulatedEvents: false, actualTool: read.name,
        ...(startup ? { startupPhase: startup.phase ?? startup.status } : {}),
        before, afterParent, afterRepeatCallId, afterChild, experimentsBefore, experimentsAfter: core?.experiments.size ?? 0,
        corePresent: Boolean(core), historyTools: ctx.tools.schemas().filter(tool => tool.name === 'evolution_history').length,
        sharedRecallRecords: recalled.failures.length + recalled.resolved.length + recalled.candidates.length,
        sharedRecallOccurrences: recalled.failures.reduce((n, row) => n + row.occurrences, 0),
        externalModelCalls: 0 };
      const knownTarget = process.env.EVOLUTION_ENTRY_PROBE_SHARED_TARGET;
      if (knownTarget) {
        const known = await history.execute({ query: knownTarget, target: knownTarget }, { agent: parent.agent, signal: new AbortController().signal });
        if (!known.resolved.some(row => row.successCount > 0)) throw new Error('Verified Desktop knowledge unavailable from this entry');
        evidence.sharedKnownTarget = knownTarget;
        evidence.sharedKnownResults = known.resolved.length;
      }
    } finally { await child.dispose(); await parent.dispose(); }
    if (core && process.env.EVOLUTION_ENTRY_PROBE_PROMOTION === '1') {
      const promotion = await runPromotionProbe(ctx, step => fs.writeFileSync(`${output}.progress`, step));
      const target = `plugin:${promotion.promotion.toolName}`;
      const shared = store.recall({ target }).records;
      if (!shared.some(row => row.state === 'KNOWN' && row.successCount > 0)) throw new Error('Verified manual promotion absent from shared knowledge');
      evidence.manualPromotion = { listenerExecuted: promotion.promotedListener,
        target, sharedKnown: true, steps: promotion.steps };
    }
    return evidence;
  }
}
