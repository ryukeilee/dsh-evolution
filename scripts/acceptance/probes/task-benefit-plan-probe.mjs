// Read-only discovery receipt for the task-benefit acceptance.
//
// The runner inserts this probe into the isolated Desktop profile before the
// host starts. It calls the production `evolution_plan` tool through the
// official tools pipeline and writes the result to a receipt file, so the
// acceptance can prove the target came from real recorded losses rather than
// from a fixture the harness chose in advance. It never proposes or promotes.
import fs from 'node:fs';

export const inject = ['tools', 'agents'];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function apply(ctx) {
  const receipt = process.env.TASK_BENEFIT_PLAN_RECEIPT;
  if (!receipt) return;
  const timer = setTimeout(async () => {
    let handle;
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (ctx.tools.get('evolution_plan') !== undefined) break;
        await sleep(500);
      }
      if (ctx.tools.get('evolution_plan') === undefined) throw new Error('evolution_plan is not registered');
      handle = await ctx.agents.create({ sessionId: `task-benefit-plan-${Date.now()}`, meta: { cwd: process.env.DSH_HOME } });
      const agent = handle.agent ?? handle;
      const batch = await ctx.tools.execute({
        agent,
        signal: AbortSignal.timeout(120_000),
        calls: [{ type: 'tool_call', id: 'plan', name: 'evolution_plan', arguments: JSON.stringify({ limit: 5 }) }],
      });
      const result = batch.results?.find((row) => row.callId === 'plan')?.result;
      if (!result || result.isError) throw new Error(`evolution_plan failed: ${JSON.stringify(result?.error ?? null).slice(0, 400)}`);
      fs.writeFileSync(receipt, JSON.stringify({ ok: true, plan: result.value }));
    } catch (error) {
      fs.writeFileSync(receipt, JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 600) }));
    } finally {
      try { await handle?.dispose?.(); } catch { /* the receipt is already written */ }
    }
  }, 2500);
  ctx.effect(() => () => clearTimeout(timer));
}
