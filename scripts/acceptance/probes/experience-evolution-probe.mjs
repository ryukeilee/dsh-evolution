/**
 * Acceptance probe: experience-driven evolution through the real host.
 *
 * Four independent processes share one `$DSH_HOME`; the phase is selected by
 * `EVOLUTION_EXPERIENCE_PHASE` and cross-phase facts are handed over through the
 * JSON file `EVOLUTION_PROBE_STATE`:
 *
 *   seed        produce REAL tool failures through the official tool pipeline
 *               (an unregistered fixture tool), let the bundled experience
 *               collector store them, ask `evolution_plan` for the candidate,
 *               then run a full propose -> probe(baseline) -> trial ->
 *               probe(candidate) -> measure -> promote -> canary flow and persist
 *               the experiment identity for the restart phase.
 *   invalid     the same flow with a candidate that does not improve the target;
 *               proves the promotion gates refuse it, the runtime is recovered
 *               and the target claim is released, and the conclusion is written
 *               back so the same strategy is refused a second time.
 *   restart     a NEW process asserts the promoted capability is really live
 *               (the tool executes through the official pipeline), the startup
 *               canary is settled, the structured conclusion is recalled from
 *               the shared store, the archive sidecar on disk carries the probe
 *               comparison/decision/applicability, and `evolution_plan` no
 *               longer proposes a new experiment for the resolved problem.
 *   regression  a candidate that fixes the target but breaks an unrelated
 *               observable capability: the scenario control step (a real fixture
 *               tool registered by this probe) starts failing, so measure must
 *               report a regression and promotion must be refused.
 *
 * Nothing here is a synthetic metric: every sample is a settled result of
 * `ctx.tools.execute({calls})` against the real registry. The probe reports raw
 * samples and the runner recomputes the counts independently; the production
 * `evolution_measure` derives before/after metrics from the samples recorded by
 * the orchestrator, and this probe submits deliberately wrong caller metrics to
 * prove they are overridden.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** The tool surface the bundle registers (lib/registration.js#EVOLUTION_TOOLS). */
const EXPECTED_EVOLUTION_TOOL_COUNT = 12;
const HEALTH_TOOL = 'probe_healthcheck';
const INVALID_TOOL = 'probe_invalid_fix';
const REGRESSION_TOOL = 'probe_regression_fix';
const HEALTH_MARKER = 'probe-healthcheck-v1';
const REGRESSION_MARKER = 'probe-regression-v1';
const HEALTH_EVENT = 'experience/evolution/health';
const INVALID_EVENT = 'experience/evolution/invalid';
const REGRESSION_HEALTH_EVENT = 'experience/evolution/regression';
const CONTROL_EVENT = 'experience/evolution/control';
const CONTROL_TOOL = 'probe_control';

export const inject = ['evolution', 'agents', 'tools', 'evolutionExperience'];

export function apply(ctx) {
  // Three real fixture tools registered by the probe itself. Each one succeeds
  // only when a mounted Cordis plugin provides the matching event listener, so a
  // candidate changes observable tool behavior without registering tools (a
  // promoted Host-only plugin cannot use the sandbox `harness.defineTool`, and
  // the acceptance must promote a real candidate). The dispatch is an ordinary
  // official Cordis event.
  const capabilityTools = [
    [HEALTH_TOOL, HEALTH_EVENT, HEALTH_MARKER],
    [INVALID_TOOL, INVALID_EVENT, 'probe-invalid-v1'],
    [REGRESSION_TOOL, REGRESSION_HEALTH_EVENT, REGRESSION_MARKER],
  ];
  for (const [toolName, eventName, marker] of capabilityTools) {
    ctx.tools.register({
      name: toolName,
      description: `Acceptance fixture capability ${toolName}: succeeds only when a mounted plugin provides its listener.`,
      parameters: { type: 'object', properties: {} },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() {
        const payload = { hits: 0 };
        await ctx.parallel(eventName, payload);
        if (payload.hits < 1) throw new Error(`the ${toolName} capability has no provider mounted`);
        return { ok: true, marker };
      },
    });
  }
  // A real host capability that exists before any Trial: the scenario control
  // step calls it. A candidate that dispatches CONTROL_EVENT changes this
  // observable behaviour; Cordis removes that listener again when the Trial is
  // disposed, so the revert must restore the control capability.
  ctx.tools.register({
    name: 'probe_control',
    description: 'Acceptance fixture control capability; fails when a candidate interferes with it.',
    parameters: { type: 'object', properties: {} },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() {
      const payload = { hits: 0 };
      await ctx.parallel(CONTROL_EVENT, payload);
      if (payload.hits !== 0) throw new Error('a mounted candidate interfered with the control capability');
      return { ok: true, marker: 'probe-control-v1' };
    },
  });

  const receive = (message) => {
    if (message !== 'run') return;
    void run().then(
      (result) => process.send?.({ result }),
      (error) => process.send?.({ error: `${String(error?.stack || error)}`.slice(0, 6000) }),
    );
  };
  ctx.effect(() => {
    process.on('message', receive);
    return () => process.off('message', receive);
  });
  process.send?.({ ready: true });

  const statePath = () => process.env.EVOLUTION_PROBE_STATE || '';
  const phase = () => process.env.EVOLUTION_EXPERIENCE_PHASE || 'seed';
  const cwd = () => process.env.EVOLUTION_ACCEPTANCE_CWD || process.cwd();

  async function waitFor(predicate, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  const evolutionTools = () => ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).map((tool) => tool.name).sort();

  /** The official registry pipeline: one settled real call per entry. */
  async function officialCalls(agent, calls) {
    if (typeof ctx.tools.execute !== 'function') {
      throw new Error('this host has no official batch tool executor; the experience acceptance requires DSH 0.2.2-rc.1');
    }
    const outcome = await ctx.tools.execute({
      agent,
      signal: new AbortController().signal,
      calls: calls.map((call) => ({
        type: 'tool_call',
        id: call.callId,
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      })),
    });
    const rows = Array.isArray(outcome?.results) ? outcome.results : [];
    return calls.map((call, index) => {
      const result = rows[index]?.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.filter((block) => block && block.type === 'text').map((block) => block.text).join('');
      return {
        callId: call.callId,
        name: call.name,
        isError: result.isError === true,
        code: result.code ?? result.error?.info?.code ?? result.error?.code ?? null,
        text: text.slice(0, 200),
      };
    });
  }

  /**
   * Wait for the live runtime signature to stop changing before a trial captures
   * its own baseline; the host creates some fibers lazily right after boot.
   */
  async function stableRuntimeSignature(call) {
    let previous = null;
    let stable = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && stable < 6) {
      const runtime = await call('evolution_runtime_inspect', {});
      const fingerprint = JSON.stringify(signatureOf(runtime));
      if (fingerprint === previous) stable += 1;
      else { stable = 0; previous = fingerprint; }
      if (stable < 6) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (stable < 6) throw new Error('the live runtime signature did not stabilize');
    return previous;
  }

  function normalizeSamples(rawSamples, scenario) {
    const steps = scenario?.steps || [];
    return (Array.isArray(rawSamples) ? rawSamples : []).map((sample, index) => {
      const name = typeof sample?.step === 'string' ? sample.step
        : typeof sample?.name === 'string' ? sample.name
        : typeof sample?.tool === 'string' ? sample.tool
          : typeof sample?.step?.name === 'string' ? sample.step.name
            : typeof sample?.call?.name === 'string' ? sample.call.name
              : null;
      const step = steps.find((entry) => entry.name === name);
      const role = typeof sample?.role === 'string' ? sample.role : (step?.role || 'target');
      return {
        index,
        name,
        role,
        repetition: Number.isInteger(sample?.repetition) ? sample.repetition : null,
        callId: typeof sample?.callId === 'string' ? sample.callId : null,
        isError: sample?.isError === true || sample?.result?.isError === true || sample?.ok === false || Boolean(sample?.error),
        code: sample?.code ?? sample?.errorCode ?? sample?.result?.error?.info?.code ?? null,
        valueDigest: typeof sample?.valueDigest === 'string' ? sample.valueDigest : null,
        at: typeof sample?.at === 'string' ? sample.at : null,
      };
    });
  }

  function summarizeSamples(samples) {
    const summary = { total: samples.length, errors: 0, target: { total: 0, errors: 0 }, control: { total: 0, errors: 0 } };
    for (const sample of samples) {
      const bucket = sample.role === 'control' ? summary.control : summary.target;
      bucket.total += 1;
      if (sample.isError) { bucket.errors += 1; summary.errors += 1; }
    }
    return summary;
  }

  function probePart(rawSamples, scenario, digest = null, reportedSummary = null, comparison = null) {
    const samples = normalizeSamples(rawSamples, scenario);
    return { samples, summary: summarizeSamples(samples), scenarioDigest: digest, reportedSummary, comparison };
  }

  async function recordBaseline(call, experimentId, scenario) {
    const raw = await call('evolution_probe', { experimentId, phase: 'baseline', scenario });
    const part = probePart(raw?.samples, scenario, raw?.scenarioDigest ?? null, raw?.baseline ?? null);
    if (part.samples.length === 0) throw new Error('the baseline probe recorded no samples');
    return part;
  }

  /** The candidate result carries the authoritative baseline rows of the same
   *  recorded run (`baselineSamples`); fall back to the baseline response. */
  async function recordCandidate(call, experimentId, scenario, baselinePart) {
    const raw = await call('evolution_probe', { experimentId, phase: 'candidate', scenario });
    const baselineSamples = Array.isArray(raw?.baselineSamples) ? raw.baselineSamples : baselinePart.samples;
    const baseline = probePart(baselineSamples, scenario, raw?.scenarioDigest ?? baselinePart.scenarioDigest, null, null);
    const candidate = probePart(raw?.samples, scenario, raw?.scenarioDigest ?? null, raw?.candidate ?? null, raw?.comparison ?? null);
    if (candidate.samples.length === 0) throw new Error('the candidate probe recorded no samples');
    return { baseline, candidate, comparison: raw?.comparison ?? null, digest: raw?.scenarioDigest ?? baselinePart.scenarioDigest };
  }

  function requireScenario(steps) {
    return { id: `experience-evolution-${phase()}-v1`, description: 'acceptance fixture: a missing capability and an independent control capability', repetitions: 3, steps };
  }

  /** Canonical knowledge scopes separate words with spaces ("tool probe x"),
   *  so compare problem identities by their alphanumeric token. */
  function tokenOf(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  async function run() {
    const activePhase = phase();
    await waitFor(() => Boolean(ctx.get('evolution')) && evolutionTools().length === EXPECTED_EVOLUTION_TOOL_COUNT,
      `the evolution service and all ${EXPECTED_EVOLUTION_TOOL_COUNT} tools`);
    const handle = await ctx.agents.create({ sessionId: `experience-evolution-${activePhase}-${Date.now()}`, meta: { cwd: cwd() } });
    const agent = handle.agent;
    const steps = [];
    const call = async (name, args, { expectedFailure = false } = {}) => {
      const definition = ctx.tools.get(name, agent);
      if (!definition) throw new Error(`the official registry cannot resolve ${name}`);
      let result;
      try {
        result = await definition.execute(args, { agent, signal: new AbortController().signal });
      } catch (error) {
        if (!expectedFailure) throw error;
        steps.push({ name, ok: false, thrown: true });
        return { ok: false, thrown: true };
      }
      steps.push({ name, ok: result?.ok !== false, phase: result?.phase });
      if (!expectedFailure && result?.ok === false) {
        throw new Error(`${name} refused: ${JSON.stringify({ phase: result?.phase, reason: result?.reason, gates: result?.gates })}`);
      }
      return result;
    };

    try {
      currentAgent = agent;
      if (activePhase === 'seed') return await seedPhase({ call, agent, steps });
      if (activePhase === 'invalid') return await invalidPhase({ call, agent, steps });
      if (activePhase === 'restart') return await restartPhase({ call, agent, steps });
      if (activePhase === 'regression') return await regressionPhase({ call, agent, steps });
      throw new Error(`unknown EVOLUTION_EXPERIENCE_PHASE ${activePhase}`);
    } finally {
      await handle.dispose();
    }
  }

  // A tiny holder so helper functions below can reuse the one agent without
  // passing it through every closure; it is set at the start of `run()`.
  let currentAgent = null;

  async function seedRepeatedFailures(toolName, count) {
    const calls = Array.from({ length: count }, (_, index) => ({ callId: `experience-seed-${toolName}-${index}`, name: toolName, arguments: {} }));
    const results = await officialCalls(currentAgent, calls);
    if (!results.every((row) => row.isError)) throw new Error(`the unregistered tool ${toolName} did not fail in the real pipeline: ${JSON.stringify(results)}`);
    return results;
  }

  async function waitForSharedEvents(store, minimum, label) {
    const before = store.stats();
    await waitFor(() => store.stats().events >= minimum, label, 15000);
    return { before, after: store.stats() };
  }

  function requiredState() {
    const file = statePath();
    if (!file) throw new Error('EVOLUTION_PROBE_STATE is required');
    return file;
  }

  async function writeState(value) {
    const file = requiredState();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async function readState() {
    const file = requiredState();
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`the seed phase did not leave its state at ${path.basename(file)}: ${error.message}`);
    }
  }

  function signatureOf(runtime) {
    return {
      // Component uids are allocation counters: they legitimately differ between
      // two observations of the same composition. Compare names, not identities.
      components: (runtime?.components || []).map((entry) => entry.name).sort(),
      services: (runtime?.services || []).map((entry) => `${entry.name}:${entry.active}`).sort(),
      events: (runtime?.events || []).map((entry) => `${entry.name}:${(entry.listeners || []).length}`).sort(),
    };
  }

  /** No dynamic plugin row and no target claim may survive the revert. */
  async function assertTrialGone(call, experimentId, pluginId) {
    const runtime = await call('evolution_runtime_inspect', {});
    const dynamic = Array.isArray(runtime?.dynamicPlugins) ? runtime.dynamicPlugins : [];
    if (pluginId && dynamic.some((entry) => (typeof entry === 'string' ? entry : entry?.pluginId) === pluginId)) {
      throw new Error(`the Trial plugin ${pluginId} survived the revert`);
    }
    const orchestrator = ctx.get('evolution')?.orchestrator;
    const owners = orchestrator?.targetOwners;
    if (owners && typeof owners.values === 'function' && [...owners.values()].includes(experimentId)) {
      throw new Error(`the target claim for ${experimentId} was not released by the revert`);
    }
    return { dynamicPlugins: dynamic.length, claimsReleased: true };
  }

  function recommendPromotion(measured) {
    return measured?.gates?.eligible === true || measured?.gates?.realBenefit === true;
  }

  async function seedPhase({ call, agent, steps }) {
    currentAgent = agent;
    const store = ctx.evolutionExperience.store;
    const before = store.stats();
    const failures = await seedRepeatedFailures(HEALTH_TOOL, 4);
    const stats = await waitForSharedEvents(store, before.events + failures.length, 'the shared experience store to absorb the real failures');

    const plan = await call('evolution_plan', { focus: `tool:${HEALTH_TOOL}`, minOccurrences: 3, limit: 5 });
    const problemKey = plan?.selected?.problemKey ?? plan?.selected?.target ?? plan?.selected?.key ?? null;
    if (plan?.ok === false) throw new Error(`evolution_plan refused: ${JSON.stringify(plan)}`);
    if (!problemKey || !tokenOf(problemKey).includes(tokenOf(HEALTH_TOOL))) {
      throw new Error(`evolution_plan did not select the repeated failure target: ${JSON.stringify(plan).slice(0, 800)}`);
    }
    const occurrences = Number(plan.selected?.occurrences ?? plan.selected?.count ?? 0);
    if (Number.isFinite(occurrences) && occurrences > 0 && occurrences < 3) {
      throw new Error(`evolution_plan selected the target with only ${occurrences} occurrence(s): ${JSON.stringify(plan.selected)}`);
    }

    await stableRuntimeSignature(call);
    const proposed = await call('evolution_propose', {
      why: 'acceptance: the runtime was missing a capability and the tool pipeline failed repeatedly',
      target: String(problemKey),
      impactScope: ['acceptance-only'],
      successMetrics: [`${HEALTH_TOOL} executes through the official tool pipeline`],
      strategy: 'register the missing tool through a reversible Trial',
      rootCause: 'the capability was absent from the live tool registry',
    });
    if (!proposed?.experimentId) throw new Error(`evolution_propose did not return an experimentId: ${JSON.stringify(proposed)}`);

    const scenario = requireScenario([
      { name: HEALTH_TOOL, arguments: {}, role: 'target' },
      { name: CONTROL_TOOL, arguments: {}, role: 'control' },
    ]);
    const baseline = await recordBaseline(call, proposed.experimentId, scenario);
    if (baseline.summary.target.total < 1 || baseline.summary.target.errors !== baseline.summary.target.total) {
      throw new Error(`the baseline target did not fail on every sample: ${JSON.stringify(baseline.summary)}`);
    }
    if (baseline.summary.control.total < 1 || baseline.summary.control.errors !== 0) {
      throw new Error(`the baseline control did not succeed: ${JSON.stringify(baseline.summary)}`);
    }

    const hostCode = [
      'return { name: "experience-evolution-health", apply(ctx) {',
      `  ctx.on(${JSON.stringify(HEALTH_EVENT)}, (payload) => { payload.hits = (payload.hits || 0) + 1; });`,
      '} };',
    ].join('\n');
    const trialed = await call('evolution_trial', {
      experimentId: proposed.experimentId,
      composition: { name: 'experience-evolution-health', purpose: 'add the missing capability through a reversible Cordis plugin', code: { host: hostCode } },
    });
    if (trialed?.ok === false) throw new Error(`evolution_trial refused the candidate: ${JSON.stringify(trialed)}`);

    const pair = await recordCandidate(call, proposed.experimentId, scenario, baseline);
    const candidate = pair.candidate;
    if (candidate.summary.target.total < 1 || candidate.summary.target.errors !== 0) {
      throw new Error(`the candidate target did not succeed: ${JSON.stringify(candidate.summary)}`);
    }
    if (candidate.summary.control.errors !== 0) {
      throw new Error(`the candidate broke the control capability: ${JSON.stringify(candidate.summary)}`);
    }

    // Deliberately wrong caller metrics: the orchestrator must derive its own
    // from the recorded probe samples.
    const measured = await call('evolution_measure', {
      experimentId: proposed.experimentId,
      observation: {
        solvesProblem: true,
        regressionPassed: true,
        reversible: true,
        cleanupEvidence: 'the follow-up promotion runs the official disposers against the captured baseline',
        beforeMetrics: { errorCount: 999 },
        afterMetrics: { errorCount: 999 },
        sampleCount: 1,
      },
    });
    const observation = measured?.observation ?? {};
    if (!observation.probe) throw new Error('evolution_measure did not persist the probe evidence on the observation');
    if (observation.beforeMetrics?.errorCount === 999 || observation.afterMetrics?.errorCount === 999) {
      throw new Error(`caller-supplied metrics were not overridden by the probe-derived ones: ${JSON.stringify({ before: observation.beforeMetrics, after: observation.afterMetrics })}`);
    }
    if (measured?.gates?.measuredEvidence !== true || measured?.gates?.realBenefit !== true) {
      throw new Error(`the measured gates did not accept the real improvement: ${JSON.stringify(measured?.gates)}`);
    }
    if (!recommendPromotion(measured)) throw new Error(`the measured experiment is not promotion-eligible: ${JSON.stringify(measured?.gates)}`);

    const ownerGate = await call('evolution_promote', { experimentId: proposed.experimentId }, { expectedFailure: true });
    if (ownerGate?.phase !== 'awaiting-owner-confirmation' || ownerGate?.ok !== false) {
      throw new Error(`the owner confirmation gate did not hold: ${JSON.stringify(ownerGate)}`);
    }
    const promoted = await call('evolution_promote', { experimentId: proposed.experimentId, confirmation: true });
    if (promoted?.ok === false) throw new Error(`evolution_promote refused the measured candidate: ${JSON.stringify(promoted)}`);

    const canary1 = await call('evolution_canary_observe', {
      experimentId: proposed.experimentId,
      startupVerified: true,
      componentHealth: 'active',
      dependenciesPresent: true,
      metricRegression: false,
      barrier: { id: 'experience-evolution-barrier-1', reached: true },
      evidence: { probeBenefit: observation.probe?.comparison?.benefit === true },
    });
    const canary2 = await call('evolution_canary_observe', {
      experimentId: proposed.experimentId,
      startupVerified: true,
      componentHealth: 'active',
      dependenciesPresent: true,
      metricRegression: false,
      barrier: { id: 'experience-evolution-barrier-2', reached: true },
      evidence: { probeBenefit: observation.probe?.comparison?.benefit === true },
    });
    if (canary2?.phase !== 'stable') {
      throw new Error(`the canary did not reach stable after its window: ${JSON.stringify({ first: canary1?.phase, second: canary2?.phase })}`);
    }

    const markerPayload = { hits: 0 };
    await ctx.parallel(HEALTH_EVENT, markerPayload);
    if (markerPayload.hits !== 1) throw new Error(`the trial listener was not executed exactly once (hits=${markerPayload.hits})`);

    const state = {
      version: 1,
      phase: 'seed',
      targetTool: HEALTH_TOOL,
      problemKey: String(problemKey),
      marker: HEALTH_MARKER,
      experimentId: proposed.experimentId,
      scenarioDigest: pair.digest ?? candidate.scenarioDigest ?? baseline.scenarioDigest,
      baseline: pair.baseline,
      candidate,
      measuredGates: measured.gates,
      promotion: { experimentId: proposed.experimentId, phase: canary2.phase, toolName: HEALTH_TOOL },
    };
    await writeState(state);

    return {
      ok: true,
      phase: 'seed',
      toolCount: evolutionTools().length,
      store: { before, after: stats.after, seededFailures: failures.length },
      plan: {
        selected: plan.selected ?? null,
        problemKey: String(problemKey),
        occurrences: Number.isFinite(occurrences) ? occurrences : null,
        versions: plan.versions ?? null,
        sources: plan.sources ?? null,
      },
      experimentId: proposed.experimentId,
      pluginId: trialed.pluginId ?? null,
      probes: { baseline: { samples: pair.baseline.samples, scenarioDigest: pair.baseline.scenarioDigest }, candidate: { samples: candidate.samples, scenarioDigest: candidate.scenarioDigest } },
      measure: { gates: measured.gates, decision: measured.decision ?? null, beforeMetrics: observation.beforeMetrics ?? null, afterMetrics: observation.afterMetrics ?? null, comparison: observation.probe?.comparison ?? null },
      canary: { first: canary1?.phase ?? null, second: canary2?.phase ?? null },
      markerHits: markerPayload.hits,
      statePath: requiredState(),
      steps,
    };
  }

  async function invalidPhase({ call, agent, steps }) {
    currentAgent = agent;
    const store = ctx.evolutionExperience.store;
    const before = store.stats();
    const failures = await seedRepeatedFailures(INVALID_TOOL, 4);
    const stats = await waitForSharedEvents(store, before.events + failures.length, 'the shared experience store to absorb the invalid-phase failures');

    const plan = await call('evolution_plan', { focus: `tool:${INVALID_TOOL}`, minOccurrences: 3, limit: 5 });
    const problemKey = plan?.selected?.problemKey ?? plan?.selected?.target ?? plan?.selected?.key ?? null;
    if (!problemKey || !tokenOf(problemKey).includes(tokenOf(INVALID_TOOL))) {
      throw new Error(`evolution_plan did not select the invalid-phase failure target: ${JSON.stringify(plan).slice(0, 800)}`);
    }

    await stableRuntimeSignature(call);
    const strategy = 'acceptance: a no-op candidate that never adds the capability';
    const proposed = await call('evolution_propose', {
      why: 'acceptance: prove an ineffective candidate is refused instead of promoted',
      target: String(problemKey),
      impactScope: ['acceptance-only'],
      successMetrics: [`${INVALID_TOOL} executes through the official tool pipeline`],
      strategy,
      rootCause: 'the capability is absent and the candidate does not add it',
    });
    if (proposed?.ok === false) throw new Error(`evolution_propose refused the ineffective experiment early: ${JSON.stringify(proposed)}`);

    const scenario = {
      id: 'experience-evolution-invalid-v1',
      description: 'acceptance fixture: an ineffective candidate must not improve the target',
      repetitions: 3,
      steps: [
        { name: INVALID_TOOL, arguments: {}, role: 'target' },
        { name: CONTROL_TOOL, arguments: {}, role: 'control' },
      ],
    };
    const baseline = await recordBaseline(call, proposed.experimentId, scenario);
    if (baseline.summary.target.errors !== baseline.summary.target.total || baseline.summary.target.total < 1) {
      throw new Error(`the invalid-phase baseline did not fail: ${JSON.stringify(baseline.summary)}`);
    }

    const hostCode = [
      'return { name: "experience-evolution-noop", apply(ctx) {',
      '  ctx.on("experience/evolution/noop", () => {});',
      '} };',
    ].join('\n');
    const trialed = await call('evolution_trial', {
      experimentId: proposed.experimentId,
      composition: { name: 'experience-evolution-noop', purpose: 'a reversible plugin that does not add the missing capability', code: { host: hostCode } },
    });
    if (trialed?.ok === false) throw new Error(`evolution_trial refused the no-op candidate: ${JSON.stringify(trialed)}`);

    const invalidPair = await recordCandidate(call, proposed.experimentId, scenario, baseline);
    const candidate = invalidPair.candidate;
    if (candidate.summary.target.errors !== candidate.summary.target.total || candidate.summary.target.total < 1) {
      throw new Error(`the ineffective candidate unexpectedly improved the target: ${JSON.stringify(candidate.summary)}`);
    }

    const measured = await call('evolution_measure', { experimentId: proposed.experimentId, observation: { solvesProblem: true, regressionPassed: true, reversible: true, cleanupEvidence: "a real revert follows and the official disposers are compared with the captured baseline" } });
    const measuredObservation = measured?.observation ?? {};
    if (measured?.gates?.measuredEvidence !== false || measured?.gates?.realBenefit !== false) {
      throw new Error(`the promotion gates accepted an ineffective candidate: ${JSON.stringify(measured?.gates)}`);
    }
    const refused = await call('evolution_promote', { experimentId: proposed.experimentId, confirmation: true }, { expectedFailure: true });
    if (refused?.ok !== false || !['promotion-gate', 'domain-evaluator-rollback'].includes(refused?.reason) || refused?.phase !== 'measured') {
      throw new Error(`promotion did not refuse the ineffective candidate through the gate: ${JSON.stringify(refused)}`);
    }

    const reverted = await call('evolution_revert', { experimentId: proposed.experimentId });
    if (reverted?.ok !== true || reverted?.runtimeRecovered !== true) {
      throw new Error(`the revert did not prove runtime recovery: ${JSON.stringify({ ok: reverted?.ok, runtimeRecovered: reverted?.runtimeRecovered })}`);
    }
    const trialGone = await assertTrialGone(call, proposed.experimentId, trialed.pluginId);

    // The target claim must be released: a new experiment on the same target can
    // be proposed and trialed (the same proof retry-probe.mjs records).
    const again = await call('evolution_propose', {
      why: 'acceptance: the runtime is free again after the refused candidate',
      target: String(problemKey),
      impactScope: ['acceptance-only'],
      successMetrics: [`${INVALID_TOOL} executes through the official tool pipeline`],
      strategy: 'acceptance: retry after the refused strategy',
    });
    if (again?.ok === false) throw new Error(`a new experiment on the same target was refused after a proven revert: ${JSON.stringify(again)}`);
    const retrial = await call('evolution_trial', {
      experimentId: again.experimentId,
      composition: { name: 'experience-evolution-retry', purpose: 'prove the target claim was released', code: { host: 'return { name: "experience-evolution-retry", apply() {} };' } },
    });
    if (retrial?.ok === false) throw new Error(`the target claim was not released after the revert: ${JSON.stringify(retrial)}`);
    await call('evolution_revert', { experimentId: again.experimentId });

    const history = await call('evolution_history', { query: String(problemKey), target: String(problemKey) });
    if (!JSON.stringify(history).includes('no-benefit') && !JSON.stringify(history).includes('ineffective')) {
      throw new Error(`the structured no-benefit conclusion is not recallable: ${JSON.stringify(history).slice(0, 800)}`);
    }
    const duplicate = await call('evolution_propose', {
      why: 'acceptance: the same strategy must not be retried without a new hypothesis',
      target: String(problemKey),
      impactScope: ['acceptance-only'],
      successMetrics: [`${INVALID_TOOL} executes through the official tool pipeline`],
      strategy,
    }, { expectedFailure: true });
    if (duplicate?.reason !== 'strategy-already-proven-ineffective') {
      throw new Error(`the repeat of a proven-ineffective strategy was not refused: ${JSON.stringify(duplicate)}`);
    }
    if (typeof duplicate.strategyFingerprint !== 'string' || !duplicate.strategyFingerprint) {
      throw new Error('the refusal did not carry a strategy fingerprint');
    }

    const markerPayload = { hits: 0 };
    await ctx.parallel('experience/evolution/noop', markerPayload);

    return {
      ok: true,
      phase: 'invalid',
      toolCount: evolutionTools().length,
      store: { before, after: stats.after, seededFailures: failures.length },
      experimentId: proposed.experimentId,
      pluginId: trialed.pluginId ?? null,
      probes: { baseline: { samples: invalidPair.baseline.samples, scenarioDigest: invalidPair.baseline.scenarioDigest }, candidate: { samples: candidate.samples, scenarioDigest: candidate.scenarioDigest } },
      measure: { gates: measured.gates, decision: measured.decision ?? null, comparison: measuredObservation?.probe?.comparison ?? null },
      refused: { reason: refused.reason, phase: refused.phase },
      revert: { ok: reverted.ok, runtimeRecovered: reverted.runtimeRecovered },
      trialGone,
      claimReleased: true,
      duplicateProposal: { reason: duplicate.reason, strategyFingerprint: duplicate.strategyFingerprint },
      conclusionRecallable: true,
      steps,
    };
  }

  async function restartPhase({ call, agent, steps }) {
    currentAgent = agent;
    const state = await readState();

    const names = evolutionTools();
    const toolSchemas = (() => { try { return ctx.tools.schemas(agent); } catch { return ctx.tools.schemas(); } })();
    const promotedVisible = toolSchemas.some((tool) => tool.name === state.targetTool) || names.includes(state.targetTool);
    if (!promotedVisible) throw new Error(`the promoted tool ${state.targetTool} is not registered after the restart`);
    const executed = await officialCalls(agent, [{ callId: 'experience-restart-tool', name: state.targetTool, arguments: {} }]);
    if (executed[0]?.isError === true) {
      throw new Error(`the promoted tool failed after the restart: ${JSON.stringify(executed)}`);
    }
    if (!String(executed[0]?.text || '').includes(state.marker)) {
      throw new Error(`the promoted tool did not return its marker after the restart: ${JSON.stringify(executed[0])}`);
    }

    const startup = await ctx.get('evolution').orchestrator.verifyStartupCanary(agent);
    const startupPhase = startup?.phase ?? startup?.status ?? 'none';
    if (!['stable', 'none', 'committed', 'committed-cleaned'].includes(startupPhase)) {
      throw new Error(`the startup canary is not settled after the restart: ${JSON.stringify(startup)}`);
    }

    const target = String(state.problemKey || `tool:${state.targetTool}`);
    const history = await call('evolution_history', { query: target, target });
    const historyJson = JSON.stringify(history);
    const sharedSources = (Array.isArray(history?.sources) ? history.sources : []).filter((source) => source?.source === 'shared-knowledge' && source?.available === true);
    const successes = countSuccesses(history);
    if (!sharedSources.length) throw new Error('the shared-knowledge source is not available after the restart');
    if (successes < 1) throw new Error(`the promoted conclusion is not recallable as a success: ${historyJson.slice(0, 800)}`);
    if (!/adopted|promotion-succeeded|benefit|KNOWN/.test(historyJson)) {
      throw new Error(`the structured adopted conclusion is not recallable after the restart: ${historyJson.slice(0, 800)}`);
    }

    const plan = await call('evolution_plan', { focus: target, limit: 5 });
    const rejectedResolved = (Array.isArray(plan?.rejected) ? plan.rejected : [])
      .some((entry) => tokenOf(entry?.problemKey).includes(tokenOf(state.targetTool)) && entry?.reason === 'already-resolved');
    const noneResolved = /already-resolved/.test(JSON.stringify(plan?.none ?? {}));
    const planSettled = plan?.ok !== false && (rejectedResolved || noneResolved);
    if (!planSettled) throw new Error(`evolution_plan still proposes a new experiment for the resolved problem: ${JSON.stringify(plan).slice(0, 800)}`);
    const planEvidence = {
      settled: planSettled,
      selected: plan?.selected?.problemKey ?? null,
      noneReason: plan?.none?.reason ?? null,
      rejectedResolved,
    };

    const dataRoot = ctx.get('evolution').dataRoot;
    const archiveDir = path.join(dataRoot, 'archive', 'experiments');
    const sidecarPath = path.join(archiveDir, `${state.experimentId}.evidence.json`);
    const markdownPath = path.join(archiveDir, `${state.experimentId}.md`);
    const sidecarText = await fs.readFile(sidecarPath, 'utf8');
    await fs.access(markdownPath);
    const sidecar = JSON.parse(sidecarText);
    if (state.scenarioDigest && !sidecarText.includes(state.scenarioDigest)) {
      throw new Error('the durable evidence sidecar does not carry the probe scenario digest');
    }
    if (!/adopted|promotion-succeeded|benefit/.test(sidecarText)) {
      throw new Error('the durable evidence sidecar does not carry the decision');
    }
    const applicability = findApplicability(sidecar);
    if (!applicability) throw new Error('the durable evidence sidecar does not carry version applicability');

    return {
      ok: true,
      phase: 'restart',
      experimentId: state.experimentId,
      toolCount: names.length,
      promotedTool: { name: state.targetTool, executed: true, markerMatched: true },
      startupPhase,
      history: { sharedSources: sharedSources.length, successes, records: summarizeHistory(history) },
      planSettled,
      plan: planEvidence,
      durableEvidence: { sidecar: true, markdown: true, scenarioDigest: Boolean(state.scenarioDigest), decision: true, applicability },
      steps,
    };
  }

  async function regressionPhase({ call, agent, steps }) {
    currentAgent = agent;
    const store = ctx.evolutionExperience.store;
    const before = store.stats();
    const failures = await seedRepeatedFailures(REGRESSION_TOOL, 3);
    const stats = await waitForSharedEvents(store, before.events + failures.length, 'the shared experience store to absorb the regression-phase failures');

    const plan = await call('evolution_plan', { focus: `tool:${REGRESSION_TOOL}`, minOccurrences: 3, limit: 5 });
    const problemKey = plan?.selected?.problemKey ?? plan?.selected?.target ?? plan?.selected?.key ?? null;
    if (!problemKey || !tokenOf(problemKey).includes(tokenOf(REGRESSION_TOOL))) {
      throw new Error(`evolution_plan did not select the regression-phase failure target: ${JSON.stringify(plan).slice(0, 800)}`);
    }
    await stableRuntimeSignature(call);
    const proposed = await call('evolution_propose', {
      why: 'acceptance: a candidate that fixes the target but regresses an independent capability',
      target: String(problemKey),
      impactScope: ['acceptance-only'],
      successMetrics: [`${REGRESSION_TOOL} executes through the official tool pipeline`],
      strategy: 'acceptance: add the capability and break the control capability',
      rootCause: 'the capability is absent',
    });
    if (proposed?.ok === false) throw new Error(`evolution_propose refused the regression experiment early: ${JSON.stringify(proposed)}`);

    const scenario = {
      id: 'experience-evolution-regression-v1',
      description: 'acceptance fixture: the target must improve and the control capability must not regress',
      repetitions: 3,
      steps: [
        { name: REGRESSION_TOOL, arguments: {}, role: 'target' },
        { name: CONTROL_TOOL, arguments: {}, role: 'control' },
      ],
    };
    const baseline = await recordBaseline(call, proposed.experimentId, scenario);
    if (baseline.summary.target.errors !== baseline.summary.target.total || baseline.summary.target.total < 1) {
      throw new Error(`the regression-phase baseline target did not fail: ${JSON.stringify(baseline.summary)}`);
    }
    if (baseline.summary.control.total < 1 || baseline.summary.control.errors !== 0) {
      throw new Error(`the regression-phase baseline control did not succeed: ${JSON.stringify(baseline.summary)}`);
    }

    const hostCode = [
      'return { name: "experience-evolution-regression", apply(ctx) {',
      `  ctx.on(${JSON.stringify(REGRESSION_HEALTH_EVENT)}, (payload) => { payload.hits = (payload.hits || 0) + 1; });`,
      `  ctx.on(${JSON.stringify(CONTROL_EVENT)}, (payload) => { payload.hits = (payload.hits || 0) + 1; });`,
      '} };',
    ].join('\n');
    const trialed = await call('evolution_trial', {
      experimentId: proposed.experimentId,
      composition: { name: 'experience-evolution-regression', purpose: 'fix the target and regress an unrelated observable capability', code: { host: hostCode } },
    });
    if (trialed?.ok === false) throw new Error(`evolution_trial refused the regression candidate: ${JSON.stringify(trialed)}`);

    const regressionPair = await recordCandidate(call, proposed.experimentId, scenario, baseline);
    const candidate = regressionPair.candidate;
    if (candidate.summary.target.errors !== 0 || candidate.summary.target.total < 1) {
      throw new Error(`the regression candidate did not improve the target: ${JSON.stringify(candidate.summary)}`);
    }
    if (candidate.summary.control.errors === 0) {
      throw new Error(`the regression candidate did not break the control capability: ${JSON.stringify(candidate.summary)}`);
    }

    const measured = await call('evolution_measure', { experimentId: proposed.experimentId, observation: { solvesProblem: true, regressionPassed: true, reversible: true, cleanupEvidence: "a real revert follows and the official disposers are compared with the captured baseline" } });
    const measuredObservation = measured?.observation ?? {};
    const regressionDetected = measured?.gates?.regressionTest === false
      || measured?.gates?.eligible === false
      || measured?.observation?.probe?.comparison?.regression === true
      || measured?.observation?.probe?.comparison?.regressionPassed === false;
    if (!regressionDetected) throw new Error(`the promotion gates did not detect the regression: ${JSON.stringify(measured?.gates)}`);
    const refused = await call('evolution_promote', { experimentId: proposed.experimentId, confirmation: true }, { expectedFailure: true });
    if (refused?.ok !== false || !['promotion-gate', 'domain-evaluator-rollback'].includes(refused?.reason)) {
      throw new Error(`promotion did not refuse the regressing candidate: ${JSON.stringify(refused)}`);
    }
    const reverted = await call('evolution_revert', { experimentId: proposed.experimentId });
    if (reverted?.ok !== true || reverted?.runtimeRecovered !== true) {
      throw new Error(`the regression experiment did not recover the runtime: ${JSON.stringify({ ok: reverted?.ok, runtimeRecovered: reverted?.runtimeRecovered })}`);
    }
    const trialGone = await assertTrialGone(call, proposed.experimentId, trialed.pluginId);
    const control = await officialCalls(agent, [{ callId: 'experience-regression-control', name: CONTROL_TOOL, arguments: {} }]);
    if (control[0]?.isError) throw new Error('the control capability stayed regressed after the revert');

    return {
      ok: true,
      phase: 'regression',
      toolCount: evolutionTools().length,
      store: { before, after: stats.after, seededFailures: failures.length },
      experimentId: proposed.experimentId,
      probes: { baseline: { samples: regressionPair.baseline.samples, scenarioDigest: regressionPair.baseline.scenarioDigest }, candidate: { samples: candidate.samples, scenarioDigest: candidate.scenarioDigest } },
      measure: { gates: measured.gates, decision: measured.decision ?? null, comparison: measuredObservation?.probe?.comparison ?? null },
      refused: { reason: refused.reason, phase: refused.phase },
      revert: { ok: reverted.ok, runtimeRecovered: reverted.runtimeRecovered },
      trialGone,
      controlRestored: true,
      steps,
    };
  }

  function countSuccesses(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined) return 0;
    if (typeof value === 'number') return 0;
    if (Array.isArray(value)) return value.reduce((total, entry) => total + countSuccesses(entry, depth + 1), 0);
    if (typeof value !== 'object') return 0;
    let total = 0;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'successCount' && typeof entry === 'number') total += entry;
      else total += countSuccesses(entry, depth + 1);
    }
    return total;
  }

  function findApplicability(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findApplicability(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const text = JSON.stringify(value);
    const dsh = /"dsh"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    const cordis = /"cordis"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    if (dsh && cordis && dsh !== 'unknown' && cordis !== 'unknown') return { dsh, cordis };
    for (const entry of Object.values(value)) {
      const found = findApplicability(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function summarizeHistory(history) {
    const groups = ['resolved', 'failures', 'candidates'];
    return Object.fromEntries(groups.map((group) => [group, Array.isArray(history?.[group]) ? history[group].length : 0]));
  }
}
