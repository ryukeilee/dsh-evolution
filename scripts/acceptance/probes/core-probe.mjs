/**
 * Acceptance probe: the core Evolution flow through the official tool registry.
 *
 * Inserted into a real DSH process through `--patch`. It uses only the public
 * host services it declares, never a model, and reports a structured result the
 * runner turns into evidence.
 *
 * Steps: inspect -> propose -> trial -> measure -> revert, plus memory
 * persistence and a complete 9-tool registration count.
 *
 * The probe never throws a whole runtime dump at the runner: on failure it
 * returns the collected steps plus a compact signature diff, so a failed
 * acceptance stays diagnosable instead of unreadable.
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

  /** A cheap, stable fingerprint of the live runtime, for before/after diffs. */
  function signatureOf(runtime) {
    const components = (runtime?.components || []).map((component) => `${component.name}#${component.uid}`).sort();
    const services = (runtime?.services || []).map((service) => `${service.name}:${service.active}`).sort();
    const events = (runtime?.events || []).map((event) => `${event.name}:${(event.listeners || []).length}`).sort();
    return { components, services, events };
  }

  function diffSignatures(before, after) {
    const changed = {};
    for (const key of ['components', 'services', 'events']) {
      const b = new Set(before[key]);
      const a = new Set(after[key]);
      const removed = [...b].filter((entry) => !a.has(entry));
      const added = [...a].filter((entry) => !b.has(entry));
      if (removed.length || added.length) changed[key] = { removed: removed.slice(0, 20), added: added.slice(0, 20) };
    }
    return changed;
  }

  async function run() {
    const names = () => ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).map((tool) => tool.name).sort();
    await waitFor(() => Boolean(ctx.get('evolution')) && names().length === 9, 'the evolution service and all 9 tools');
    const tools = names();

    const handle = await ctx.agents.create({
      sessionId: `evolution-acceptance-${Date.now()}`,
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

    try {
      // The host creates some fibers lazily right after boot (for example the
      // dynamic Cordis runner). Wait for boot to finish so later drift during
      // the trial remains a real failure. Below we deliberately load a normal
      // host plugin between propose and trial to exercise the trial boundary.
      let previous = null;
      let stable = 0;
      const stableDeadline = Date.now() + 20000;
      while (Date.now() < stableDeadline && stable < 4) {
        const definition = ctx.tools.get('evolution_runtime_inspect', agent);
        if (!definition) throw new Error('the official registry cannot resolve evolution_runtime_inspect');
        const runtime = await definition.execute({}, { agent, signal: new AbortController().signal });
        const fingerprint = JSON.stringify(signatureOf(runtime));
        if (fingerprint === previous) stable += 1;
        else { stable = 0; previous = fingerprint; }
        if (stable < 4) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (stable < 4) throw new Error('the live runtime signature did not stabilize');
      steps.push({ name: 'runtime-stable', ok: true });

      const existingMemory = ctx.evolution.orchestrator.memory.snapshot().entries;
      const baselineRuntime = await call('evolution_runtime_inspect', {});
      let baseline = signatureOf(baselineRuntime);

      const proposed = await call('evolution_propose', {
        why: 'release acceptance probe',
        target: 'plugin:acceptance-probe',
        impactScope: ['acceptance-only'],
        successMetrics: ['cleanup restores the pre-trial baseline'],
      });
      if (proposed?.ok === false) return { tools, toolCount: tools.length, steps, failure: 'propose refused' };

      let loaded = false;
      const lateHost = ctx.plugin({ name: 'acceptance-late-host', apply(scope) {
        scope.on('evolution/acceptance-late-host', () => {});
        loaded = true;
      } });
      // A normal official Cordis registration, with no DSH source patch.
      ctx.effect(() => () => lateHost.dispose());
      await waitFor(() => loaded, 'the host plugin loaded after propose');
      const preTrialRuntime = await call('evolution_runtime_inspect', {});
      const preTrialSignature = signatureOf(preTrialRuntime);
      const boundaryDiff = diffSignatures(baseline, preTrialSignature);
      if (!Object.keys(boundaryDiff).length) throw new Error('the pre-trial drift fixture changed no runtime facts');
      baseline = preTrialSignature;
      steps.push({ name: 'pre-trial-host-drift', ok: true });

      const trial = await call('evolution_trial', {
        experimentId: proposed.experimentId,
        composition: {
          name: 'acceptance-probe',
          purpose: 'prove a reversible Cordis registration is installed and torn down',
          code: { host: 'return { name: "evolution-acceptance-listener", apply(ctx) { ctx.on("evolution/acceptance", () => {}); } };' },
        },
      });
      if (trial?.ok === false) return { tools, toolCount: tools.length, steps, failure: 'trial refused' };

      const measured = await call('evolution_measure', {
        experimentId: proposed.experimentId,
        observation: {
          solvesProblem: true,
          metrics: { errors: 0 },
          beforeMetrics: { errors: 1 },
          afterMetrics: { errors: 0 },
          sampleCount: 1,
          observationWindow: 'acceptance-probe',
          benefitEvidence: 'a reversible Cordis listener was installed and observed',
          repeatable: true,
          regressionPassed: true,
          reversible: true,
          cleanupEvidence: 'evolution_revert is the next step',
        },
      });
      if (measured?.ok === false) return { tools, toolCount: tools.length, steps, failure: 'measure refused' };

      const reverted = await call('evolution_revert', { experimentId: proposed.experimentId });
      const afterRuntime = await call('evolution_runtime_inspect', {});
      const signatureDiff = diffSignatures(baseline, signatureOf(afterRuntime));

      const dataRoot = ctx.evolution.dataRoot;
      await fs.access(path.join(dataRoot, 'evolution-memory.json'));
      const afterMemory = ctx.evolution.orchestrator.memory.snapshot().entries;
      const existingRetained = existingMemory.every((entry) => afterMemory.some((current) => current.signature === entry.signature));

      return {
        tools,
        toolCount: tools.length,
        steps,
        reverted: reverted?.ok === true,
        cleanupProof: reverted?.cleanupProof,
        stop: reverted?.stop,
        removed: reverted?.removed,
        signatureDiff,
        dataRoot,
        memoryPersisted: true,
        memoryEntriesBefore: existingMemory.length,
        memoryEntriesAfter: afterMemory.length,
        existingMemoryRetained: existingRetained,
      };
    } finally {
      await handle.dispose();
    }
  }
}
