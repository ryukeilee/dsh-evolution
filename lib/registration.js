import { EvolutionOrchestrator, toLosslessJson } from "./orchestrator.js";

// Proposal #1: every evolution_* tool result crosses the harness output gate,
// which rejects non-lossless JSON wholesale. Project each successful result
// through the same pure boundary projection; thrown errors are untouched.
const losslessResult = (value) => toLosslessJson(value);

export const name = "dsh-evolution-orchestrator";
export const inject = ["tools", "dynamicCordisRunner", "systemPrompt"];

const output = {
  // DSH raw tool schemas accept `{}` as the supported unconstrained-JSON
  // annotation form; `type: "json"` is only valid in author-side parameter
  // specs and fails real registry validation during preset loading.
  schema: {},
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
};

const systemText = `
Evolution is an orchestration layer above the existing Cordis Runtime. It never
creates a second registry, resolver, lifecycle manager, or effect tracker.

Use the lifecycle exactly in this order:
1. evolution_runtime_inspect — read live Cordis components, services, tools,
   dependencies, events, dynamic Plugins, and inspect providers.
2. evolution_propose — record why/target/impact/success metrics and an owner.
3. evolution_trial — define and activate a temporary Host-only or approval-aware
   Cordis Package through dynamicCordisRunner.
4. evolution_measure — record problem resolution, side effects, performance,
   errors, repeatability, regression, reversibility, and explicit cleanup
   evidence.
5. evolution_revert or evolution_promote — dispose through Cordis first. Promotion
   is rejected unless benefit, repeatability, regression, reversibility, and
   orphan-free cleanup are all evidenced. A promotion writes a durable Plugin
   row and archive pointer for the NEXT session, then remains in deterministic
   canary observation until startup, health, dependency, and metric barriers
   prove a stable commit. Any regression rolls back to last known good.

Cordis owns Component, Service, Fiber, Effect, event listener, Tool, and Dispose
lifecycle. Every temporary capability must use ctx.effect(), ctx.on(), or an
official Cordis API that returns a disposer. Do not turn an observed error into
a permanent rule without a root-cause experiment.
`;

function compositionParameters() {
  return {
    experimentId: { type: "string", required: true },
    idPrefix: { type: "string", description: "Optional 3–6 lowercase semantic prefix for the Host-minted dynamic Plugin ID." },
    composition: {
      type: "object",
      required: true,
      properties: {
        name: { type: "string", required: true },
        purpose: { type: "string", required: true },
        code: {
          type: "object",
          required: true,
          properties: {
            host: { type: "string", required: true },
            client: { type: "string" },
          },
        },
      },
    },
  };
}

// Cordis's raw `ctx.tools.register()` surface expects JSON Schema parameters;
// the local declarations above intentionally use the author-facing per-field
// spec. Compile that small spec locally so real registry loading sees a typed
// object root (and keep `type: "json"` as the supported unconstrained `{}`).
function parameterSchema(spec) {
  const properties = {};
  const required = [];
  for (const [name, raw] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...schema } = raw ?? {};
    properties[name] = normalizeSchema(schema);
    if (isRequired === true) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.type === "json") return {};
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const nested = parameterSchema(schema.properties);
    const { properties: _authorProperties, ...rest } = schema;
    return {
      ...rest,
      type: "object",
      properties: nested.properties,
      ...(nested.required ? { required: nested.required } : {}),
    };
  }
  if (schema.type === "array" && schema.items?.type === "json") {
    return { ...schema, items: {} };
  }
  return schema;
}

// A preset is mounted per session, but the startup drift snapshot is a
// process-wide fact: without this cache every new session hashes the whole
// backup again (~450ms CPU + I/O) and concurrent sessions duplicate the work.
// Cache per drift state file; remove the entry when the baseline is missing so
// a later session can retry once the release state exists.
const startupDriftChecks = new Map();
function ensureStartupDrift(orchestrator, ctx) {
  const key = orchestrator.paths.driftStatePath;
  const pending = startupDriftChecks.get(key);
  if (pending) return pending;
  const check = orchestrator.inspectStartupDrift().then((result) => {
    if (!result || result.status === "baseline-missing" || result.status === "backup-unavailable") {
      startupDriftChecks.delete(key);
    }
    return result;
  }, (error) => {
    startupDriftChecks.delete(key);
    ctx.logger?.warn?.(`[evolution] startup drift check unavailable: ${error?.message || error}`);
    return null;
  });
  startupDriftChecks.set(key, check);
  return check;
}

export function apply(ctx, config = {}) {
  const orchestrator = new EvolutionOrchestrator(ctx, config);
  if (config.startupDrift !== false) void ensureStartupDrift(orchestrator, ctx);
  ctx.systemPrompt.section({ name: "tool:evolution-orchestrator", order: 116, text: systemText });
  const register = (definition) => ctx.tools.register({
    ...definition,
    parameters: parameterSchema(definition.parameters),
    execute: async (args, exec) => {
      try { return await definition.execute(args, exec); }
      finally { await config.domainStorage?.flush(); }
    },
  });
  if (config.domainStorage) register({
    name: 'evolution_history', description: 'Read bounded non-sensitive domain history metadata, counts, and independent metric integration status.',
    parameters: { collection: { type: 'string' }, limit: { type: 'number' } }, output,
    execute: args => config.domainStorage.query(args.collection, args.limit),
  });
  register({
    name: "evolution_runtime_inspect",
    description: "Inspect the live Cordis Runtime. Returns facts from Cordis registries and scoped services; it does not use a static Evolution inventory.",
    parameters: {},
    output,
    execute: (_args, exec) => Promise.resolve(losslessResult(orchestrator.inspect(exec.agent))),
  });
  register({
    name: "evolution_propose",
    description: "Create an owned Evolution Proposal before changing the Cordis composition.",
    parameters: {
      why: { type: "string", required: true },
      target: { type: "string", required: true },
      impactScope: { type: "array", items: { type: "string" }, required: true },
      successMetrics: { type: "array", items: { type: "string" }, required: true },
      risk: { type: "string", description: "low, medium, or high; autonomous execution only accepts low." },
      targets: {
        type: "object",
        properties: {
          components: { type: "array", items: { type: "string" } },
          plugins: { type: "array", items: { type: "string" } },
          configurations: { type: "array", items: { type: "string" } },
        },
      },
    },
    output,
    execute: async (args, exec) => {
      if (config.prepareRuntime) await config.prepareRuntime(exec.agent, exec.signal);
      return losslessResult(orchestrator.propose(args, exec));
    },
  });
  register({
    name: "evolution_trial",
    description: "Define and activate a temporary Cordis Package for an existing Evolution Proposal. The Host Runner owns its Fiber and lifecycle.",
    parameters: compositionParameters(),
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.trial(args, exec)),
  });
  register({
    name: "evolution_measure",
    description: "Record an Observation for a running Evolution Trial and evaluate the Promotion gates.",
    parameters: {
      experimentId: { type: "string", required: true },
      observation: {
        type: "object",
        required: true,
        properties: {
          solvesProblem: { type: "boolean", required: true },
          sideEffects: { type: "array", items: { type: "string" } },
          orphanResources: { type: "array", items: { type: "string" } },
          performanceChange: { type: "json" },
          errorChange: { type: "json" },
          metrics: { type: "object" },
          beforeMetrics: { type: "object", description: "Baseline metrics captured before the Trial." },
          afterMetrics: { type: "object", description: "Metrics captured after the Trial observation window." },
          observationWindow: { type: "json", description: "The measured observation interval or window identifier." },
          sampleCount: { type: "number", description: "Positive number of samples represented by afterMetrics." },
          benefitEvidence: { type: "string" },
          repeatable: { type: "boolean" },
          regressionPassed: { type: "boolean" },
          reversible: { type: "boolean" },
          cleanupEvidence: { type: "string" },
        },
      },
    },
    output,
    execute: (args, exec) => Promise.resolve(losslessResult(orchestrator.measure(args, exec))),
  });
  register({
    name: "evolution_revert",
    description: "Stop and undefine a temporary Evolution Plugin through Cordis, then prove the Runtime signature returned to its baseline.",
    parameters: { experimentId: { type: "string", required: true } },
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.revert(args, exec)),
  });
  register({
    name: "evolution_promote",
    description: "Prepare, apply, and verify a measured Trial as a durable Cordis Plugin, then enter canary observation. Stable commit requires deterministic startup/health/dependency/metric barriers. Set confirmation=true only after reviewing the measured evidence and rollback proof; false or omitted returns an owner-confirmation result without mutating production.",
    parameters: {
      experimentId: { type: "string", required: true },
      confirmation: { type: "boolean", description: "Explicit owner confirmation for production promotion. Only true authorizes the promotion; false or omitted is a read-only confirmation request." },
    },
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.promote(args, exec)),
  });
  register({
    name: "evolution_canary_observe",
    description: "Advance a pending promotion canary at a deterministic barrier. Startup, component health, dependencies, and metrics must remain healthy; regression automatically rolls back.",
    parameters: {
      experimentId: { type: "string", required: true },
      startupVerified: { type: "boolean", required: true },
      componentHealth: { type: "string", required: true },
      dependenciesPresent: { type: "boolean", required: true },
      metricRegression: { type: "boolean", required: true },
      metrics: { type: "object" },
      evidence: { type: "object" },
      barrier: {
        type: "object",
        required: true,
        properties: { id: { type: "string", required: true }, reached: { type: "boolean", required: true } },
      },
    },
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.observeCanary(args, exec)),
  });
  if (typeof ctx.on === "function") {
    let startupChecked = false;
    ctx.on("agent/pre-step", async (payload, next) => {
      if (!startupChecked && payload?.agent) {
        startupChecked = true;
        await orchestrator.verifyStartupCanary(payload.agent);
      }
      await config.domainStorage?.flush();
      return next();
    });
    if (orchestrator.autonomous || config.observe === true || config.domainStorage) {
      // Official 0.2.0 agent/error is emit, NOT a waterfall: it supplies no
      // next callback. Contain async observer failures without affecting the
      // original agent error or silently claiming successful observation.
      ctx.on("agent/error", (payload) => {
        if (!payload?.agent) return;
        const error = payload.error;
        // Keep the real diagnostic message so distinct failures get distinct
        // pattern keys; `projectObservation` still replaces it with a constant
        // before anything reaches the durable domain store.
        const observation = {
          type: "agent/error",
          code: typeof error?.code === "string" ? error.code : "AGENT_ERROR",
          message: typeof error?.message === "string" && error.message ? error.message : "Official agent operation failed",
          target: "agent",
        };
        void (async () => {
          await config.domainStorage?.observe(observation);
          return orchestrator.observeAutonomous(observation, {
          agent: payload.agent,
          signal: payload.signal || new AbortController().signal,
          });
        })().catch(error => ctx.logger?.warn?.(`[evolution] agent error observer failed: ${error?.message || error}`));
      });
      ctx.on("tools/result", async (exec, result) => {
        if (!result?.isError || !exec?.agent || String(exec.name || "").startsWith("evolution_")) return;
        const message = (result.content || []).find((entry) => entry?.type === "text")?.text || `tool ${exec.name} failed`;
        const safeObservation = { type: 'tool/error', code: result.code, target: `tool:${exec.name}` };
        await config.domainStorage?.observe(safeObservation);
        return orchestrator.observeAutonomous({
          agent: exec.agent,
          type: "tool/error",
          code: result.code || `TOOL_${String(exec.name || "UNKNOWN").toUpperCase()}`,
          message: `Official operation failed (${safeObservation.code || "HOST_OPERATION_FAILED"})`,
          target: `tool:${exec.name}`,
        }, { agent: exec.agent, signal: exec.signal || new AbortController().signal });
      });
    }
  }
  return orchestrator;
}

export { EvolutionOrchestrator } from "./orchestrator.js";
