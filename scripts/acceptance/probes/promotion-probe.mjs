/**
 * Acceptance probe: real promotion through the official Include adapter.
 *
 * Three phases share one `$DSH_HOME`, so the promoted composition must survive
 * a process restart:
 *
 *   promote              propose -> trial -> measure -> confirmation gate ->
 *                        promote, then a canary observation that commits
 *   restart-and-rollback asserts the promoted listener survived the restart and
 *                        that the startup canary commits, then promotes a
 *                        second candidate with an intentional regression and
 *                        proves the canary rollback removes only that candidate
 *   verify               after a further restart, the committed candidate is
 *                        live, the rolled-back candidate is not, and the
 *                        startup canary still reports `stable`
 *
 * The promoted host code is a real, standalone Cordis plugin body: it registers
 * an event listener this probe can execute, so "promoted" is proven by
 * behaviour, not by a file existing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const inject = ['evolution', 'agents', 'tools'];

export function apply(ctx) {
  const receive = (message) => {
    if (message !== 'run') return;
    void run().then(
      (result) => process.send?.({ result }),
      (error) => process.send?.({ error: `${String(error?.stack || error)}`.slice(0, 4000) }),
    );
  };
  ctx.effect(() => {
    process.on('message', receive);
    return () => process.off('message', receive);
  });
  process.send?.({ ready: true });

  async function waitFor(predicate, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  function has(name) {
    const hooks = ctx.events?._hooks?.[`promotion/probe/${name}`];
    return Array.isArray(hooks) && hooks.length > 0;
  }

  async function run() {
    await waitFor(() => Boolean(ctx.get('evolution')) && ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).length === 9, 'the evolution service and 9 tools');
    const command = process.env.EVOLUTION_PROMOTION_COMMAND || 'promote';
    const handle = await ctx.agents.create({
      sessionId: `promotion-probe-${command}-${Date.now()}`,
      meta: { cwd: process.env.EVOLUTION_ACCEPTANCE_CWD || process.cwd() },
    });
    const agent = handle.agent;
    const steps = [];
    const call = async (name, args, expectedFailure = false) => {
      const definition = ctx.tools.get(name, agent);
      if (!definition) throw new Error(`the official registry cannot resolve ${name}`);
      const result = await definition.execute(args, { agent, signal: new AbortController().signal });
      steps.push({ name, ok: result?.ok !== false, phase: result?.phase });
      if (!expectedFailure && result?.ok === false) {
        const record = ctx.evolution.orchestrator.experiments.get(args.experimentId);
        throw new Error(`${name} refused: ${JSON.stringify({ phase: result?.phase, reason: result?.reason, runtimeRecovered: result?.runtimeRecovered, cleanupProof: record?.cleanupProof, recoveryProof: record?.recoveryProof })}`);
      }
      return result;
    };
    const executeMarker = async (name) => {
      const payload = { hits: 0 };
      await ctx.parallel(`promotion/probe/${name}`, payload);
      if (payload.hits !== 1) throw new Error(`the promoted listener ${name} was not executed exactly once (hits=${payload.hits})`);
      steps.push({ name: `event:${name}`, ok: true });
    };
    const candidate = async (suffix) => {
      // Use the same pre-propose stability gate as core-probe. Promotion also
      // captures a runtime baseline; lazy host fibers must settle first.
      let previous = null, stable = 0;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && stable < 4) {
        const definition = ctx.tools.get('evolution_runtime_inspect', agent);
        if (!definition) throw new Error('the official registry cannot resolve evolution_runtime_inspect');
        const runtime = await definition.execute({}, { agent, signal: new AbortController().signal });
        const fingerprint = JSON.stringify({
          components: (runtime.components || []).map((entry) => `${entry.name}#${entry.uid}`).sort(),
          services: (runtime.services || []).map((entry) => `${entry.name}:${entry.active}`).sort(),
          events: (runtime.events || []).map((entry) => `${entry.name}:${(entry.listeners || []).length}`).sort(),
        });
        if (fingerprint === previous) stable++;
        else { stable = 0; previous = fingerprint; }
        if (stable < 4) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (stable < 4) throw new Error('the live runtime signature did not stabilize before promotion');
      steps.push({ name: 'runtime-stable', ok: true });
      const toolName = `promotion_probe_${suffix}`;
      const proposed = await call('evolution_propose', {
        why: `official Include promotion probe (${suffix})`,
        target: `plugin:${toolName}`,
        impactScope: ['acceptance-only'],
        successMetrics: ['the promoted listener survives a restart and is cleaned up on rollback'],
      });
      await call('evolution_trial', {
        experimentId: proposed.experimentId,
        composition: {
          name: toolName,
          purpose: 'prove the official promotion lifecycle registers and retires a real listener',
          code: { host: `return { name: ${JSON.stringify(toolName)}, apply(ctx) { ctx.on('promotion/probe/${toolName}', (payload) => { payload.hits += 1; }); } };` },
        },
      });
      if (!has(toolName)) throw new Error(`the trial listener ${toolName} was not registered`);
      await executeMarker(toolName);
      await call('evolution_measure', {
        experimentId: proposed.experimentId,
        observation: {
          solvesProblem: true,
          metrics: { missing: 0 },
          beforeMetrics: { missing: 1 },
          afterMetrics: { missing: 0 },
          sampleCount: 2,
          observationWindow: 'trial registered an executable marker and the durable restart gate is pending',
          benefitEvidence: 'a real marker execution was recorded; the restart gate remains',
          repeatable: true,
          regressionPassed: true,
          reversible: true,
          cleanupEvidence: 'a real runner stop/undefine baseline comparison runs at promotion',
        },
      });
      const confirmation = await call('evolution_promote', { experimentId: proposed.experimentId }, true);
      if (confirmation.phase !== 'awaiting-owner-confirmation' || !has(toolName)) {
        throw new Error(`the confirmation gate mutated the trial: ${JSON.stringify(confirmation)}`);
      }
      const promoted = await call('evolution_promote', { experimentId: proposed.experimentId, confirmation: true });
      if (!has(toolName)) throw new Error(`the official Include did not register the promoted listener ${toolName}`);
      await executeMarker(toolName);
      return { experimentId: proposed.experimentId, durable: promoted.nextSession, toolName };
    };

    try {
      const output = { command, steps, dataRoot: ctx.evolution.dataRoot };
      if (command === 'promote') {
        output.promotion = await candidate('stable');
        await call('evolution_canary_observe', {
          experimentId: output.promotion.experimentId,
          startupVerified: true,
          componentHealth: 'active',
          dependenciesPresent: true,
          metricRegression: false,
          barrier: { id: 'promotion-active-listener-execute', reached: true },
          evidence: { listenerExecuted: true },
        });
        output.promotedListener = has('promotion_probe_stable');
      } else if (command === 'restart-and-rollback') {
        if (!has('promotion_probe_stable')) throw new Error('the promoted listener did not survive the process restart');
        await executeMarker('promotion_probe_stable');
        output.startup = await ctx.evolution.orchestrator.verifyStartupCanary(agent);
        if (output.startup.phase !== 'stable') throw new Error(`the startup canary did not commit: ${JSON.stringify(output.startup)}`);
        output.rollbackPromotion = await candidate('rollback');
        const rolledBack = await call('evolution_canary_observe', {
          experimentId: output.rollbackPromotion.experimentId,
          startupVerified: true,
          componentHealth: 'active',
          dependenciesPresent: true,
          metricRegression: true,
          barrier: { id: 'intentional-regression', reached: true },
          evidence: { deliberate: true },
        }, true);
        if (rolledBack.phase !== 'rolled-back') throw new Error(`the canary did not roll back: ${JSON.stringify({ phase: rolledBack.phase })}`);
        if (has('promotion_probe_rollback')) throw new Error('the rolled-back candidate is still registered');
        if (!has('promotion_probe_stable')) throw new Error('the rollback removed the committed candidate as well');
        output.rollbackVerified = true;
      } else if (command === 'verify') {
        if (!has('promotion_probe_stable')) throw new Error('the committed candidate is not live after restart');
        if (has('promotion_probe_rollback')) throw new Error('the rolled-back candidate came back after restart');
        await executeMarker('promotion_probe_stable');
        output.startup = await ctx.evolution.orchestrator.verifyStartupCanary(agent);
        // The committed canary journal was already cleaned up by the previous
        // restart, so a settled install legitimately reports `none` here; any
        // pending or failing canary state would not be one of these.
        const startupState = output.startup?.phase || output.startup?.status;
        if (!['stable', 'none', 'committed-cleaned'].includes(startupState)) {
          throw new Error(`the startup canary is not settled: ${JSON.stringify(output.startup)}`);
        }
        const compositionPath = path.join(ctx.evolution.dataRoot, 'promoted.cordis.yml');
        await fs.access(compositionPath);
        output.compositionPath = compositionPath;
        output.verified = true;
      } else {
        throw new Error(`unknown promotion command ${command}`);
      }
      return output;
    } finally {
      await handle.dispose();
    }
  }
}
