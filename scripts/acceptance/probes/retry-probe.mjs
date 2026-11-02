/**
 * Acceptance probe: does a retried cleanup prove runtime recovery?
 *
 * `revert()` keeps the target claim and the experiment record when the official
 * disposers do not prove the Trial is gone, and it accepts those two states again
 * so the cleanup can be retried. That retry only works if the disposers' "already
 * in that state" receipts count as proof: `stop` answers `not-running` once the run
 * was stopped and `plugin-missing` once the plugin is gone, and `undefine` answers
 * `plugin-missing` for a plugin that is already removed
 * (`DynamicCordisStopResponse` / `DynamicCordisUndefineReceipt`).
 *
 * This probe reaches that state in a real host without patching DSH: it drives the
 * installed bundle through the official tool registry, then removes the Trial out of
 * band through the same official `dynamicCordisRunner`, which leaves exactly the
 * receipts a retry sees. It then calls `evolution_revert` and starts a second Trial
 * on the same target.
 *
 * Not part of the fixed acceptance step list (`run-host-acceptance.mjs` keeps its 21
 * steps). Run it against a prepared acceptance environment - the harness keeps one
 * with `--keep`, so `env/runtime`, `env/home` and `env/logs` exist:
 *
 *   printf -- "- insert:\n    - id: evolution-retry-probe\n      name: '%s'\n" \
 *     "$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' \
 *        "$PWD/scripts/acceptance/probes/retry-probe.mjs")" > env/retry-probe.patch.yml
 *   DSH_HOME=env/home node env/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js \
 *     --profile web --patch env/retry-probe.patch.yml -- --no-open --host 127.0.0.1 --port 0
 *
 * The probe answers the `run` message and reports one JSON result through IPC, the
 * same contract `core-probe.mjs` and `lifecycle-probe.mjs` use. Its before/after
 * output against the pinned `0.2.0` build and against a build of this change is
 * recorded in `docs/evidence/revert-retry-20261102-real-host.json`.
 */
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

  async function run() {
    const names = () => ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).map((tool) => tool.name).sort();
    await waitFor(() => Boolean(ctx.get('evolution')) && names().length === 10, 'the evolution service and all 10 tools');
    const handle = await ctx.agents.create({
      sessionId: `evolution-retry-probe-${Date.now()}`,
      meta: { cwd: process.env.EVOLUTION_ACCEPTANCE_CWD || process.cwd() },
    });
    const agent = handle.agent;
    const steps = [];
    const call = async (name, args) => {
      const definition = ctx.tools.get(name, agent);
      if (!definition) throw new Error(`the official registry cannot resolve ${name}`);
      const result = await definition.execute(args, { agent, signal: new AbortController().signal });
      steps.push({ name, ok: result?.ok !== false, phase: result?.phase, runtimeRecovered: result?.runtimeRecovered });
      return result;
    };

    // Let boot settle so later drift during the trial stays a real failure.
    let previous = null;
    let stable = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && stable < 4) {
      const definition = ctx.tools.get('evolution_runtime_inspect', agent);
      const runtime = await definition.execute({}, { agent, signal: new AbortController().signal });
      const fingerprint = JSON.stringify((runtime.components || []).map((entry) => entry.name).sort());
      if (fingerprint === previous) stable += 1; else { stable = 0; previous = fingerprint; }
      if (stable < 4) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (stable < 4) throw new Error('the live runtime signature did not stabilize');

    const orchestrator = ctx.get('evolution').orchestrator;
    const proposed = await call('evolution_propose', {
      why: 'real-host retried cleanup probe',
      target: 'plugin:retry-probe',
      impactScope: ['acceptance-only'],
      successMetrics: ['a retried cleanup proves recovery'],
    });
    if (proposed?.ok === false) return { steps, failure: 'propose refused' };
    const experimentId = proposed.experimentId;

    const trialed = await call('evolution_trial', {
      experimentId,
      composition: {
        name: 'retry-probe',
        purpose: 'hold a reversible Cordis listener while the cleanup receipts are captured',
        code: { host: 'return { name: "evolution-retry-probe", apply(ctx) { ctx.on("evolution/retry-probe", () => {}); } };' },
      },
    });
    if (trialed?.ok === false) return { steps, failure: 'trial refused' };
    const pluginId = trialed.pluginId;

    // The official disposers, called the way a first cleanup attempt leaves them:
    // stop (ok), stop again, undefine (ok), undefine again. The second call of each
    // is what a retried cleanup sees.
    const firstStop = await orchestrator.runner.stop(agent, pluginId);
    const secondStop = await orchestrator.runner.stop(agent, pluginId);
    const firstUndefine = await orchestrator.runner.undefine(agent, pluginId);
    const secondUndefine = await orchestrator.runner.undefine(agent, pluginId);

    // The Trial's plugin is gone; the record still owns the runtime until a cleanup
    // proves it.
    const reverted = await call('evolution_revert', { experimentId });

    // Can the session continue on the same target?
    const again = await call('evolution_propose', {
      why: 'real-host retried cleanup probe, second experiment',
      target: 'plugin:retry-probe',
      impactScope: ['acceptance-only'],
      successMetrics: ['the runtime is free again'],
    });
    let retrial = null;
    let retrialError = null;
    if (again?.ok !== false) {
      try {
        retrial = await call('evolution_trial', {
          experimentId: again.experimentId,
          composition: {
            name: 'retry-probe-2',
            purpose: 'prove the runtime is free after a retried cleanup',
            code: { host: 'return { name: "evolution-retry-probe-2", apply() {} };' },
          },
        });
      } catch (error) {
        retrialError = { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) };
      }
      if (retrial?.ok !== false && !retrialError) await call('evolution_revert', { experimentId: again.experimentId });
    }

    return {
      steps,
      pluginId,
      receipts: { firstStop, secondStop, firstUndefine, secondUndefine },
      revert: {
        ok: reverted?.ok ?? null,
        phase: reverted?.phase ?? null,
        runtimeRecovered: reverted?.runtimeRecovered ?? null,
        stop: reverted?.stop ?? null,
        removed: reverted?.removed ?? null,
        cleanupProof: orchestrator.experiments.get(experimentId)?.cleanupProof ?? null,
      },
      retrial: { ok: retrial?.ok ?? null, phase: retrial?.phase ?? null, error: retrialError },
    };
  }
}
