// Real new-session execution proof. Only the acceptance's isolated profile loads this.
import fs from 'node:fs';
import crypto from 'node:crypto';
export const inject = ['tools', 'agents'];
export function apply(ctx) {
  const receipt = process.env.EVOLUTION_WORKFLOW_RECEIPT;
  const timer = setTimeout(async () => {
    let handle;
    try {
      const name = process.env.EVOLUTION_WORKFLOW_TOOL;
      const profile = process.env.EVOLUTION_WORKFLOW_PROFILE;
      const schemas = ctx.tools.schemas();
      if (schemas.filter((tool) => tool.name === name).length !== 1) throw new Error('published tool is not registered exactly once');
      const kernel = schemas.some((tool) => tool.name === 'evolution_trial');
      if (kernel !== (profile === 'desktop')) throw new Error('unexpected kernel role');
      handle = await ctx.agents.create({ sessionId: `workflow-reuse-${profile}-${Date.now()}`, meta: { cwd: process.env.DSH_HOME } });
      const batch = await ctx.tools.execute({ agent: handle.agent ?? handle, signal: AbortSignal.timeout(30000),
        calls: [{ type: 'tool_call', id: 'reuse', name, arguments: JSON.stringify({ file_path: process.env.EVOLUTION_WORKFLOW_FILE, offset: 1, limit: 1 }) }] });
      const result = batch.results?.find((row) => row.callId === 'reuse')?.result;
      if (!result || result.isError) throw new Error('published workflow call failed');
      const text = result.value?.lines?.[0]?.text;
      if (typeof text !== 'string') throw new Error('published workflow returned no line');
      const digest = crypto.createHash('sha256').update(text).digest('hex');
      if (digest !== process.env.EVOLUTION_WORKFLOW_SHA) throw new Error('published workflow returned an incomplete or changed line');
      fs.writeFileSync(receipt, JSON.stringify({ ok: true, profile, name, kernel, outputSha256: digest, characters: text.length, executor: 'official tools.execute', freshSession: true }));
    } catch (error) {
      fs.writeFileSync(receipt, JSON.stringify({ ok: false, error: String(error.message).slice(0, 500) }));
    } finally { await handle?.dispose?.(); }
  }, 2500);
  ctx.effect(() => () => clearTimeout(timer));
}
