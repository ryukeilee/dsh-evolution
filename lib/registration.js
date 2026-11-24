import { EvolutionOrchestrator, safeErrorDto, toLosslessJson, toolFailurePatternDigest } from "./orchestrator.js";
import { types } from "node:util";
import { redactedToolError, warnRedacted, toolFailureCode } from "./error-boundary.js";
import { isVerificationCall } from "./verification-call.js";

export { redactedToolError, warnRedacted };

// Proposal #1: every evolution_* tool result crosses the harness output gate,
// which rejects non-lossless JSON wholesale. Project each successful result
// through the same pure boundary projection.
const losslessResult = (value) => toLosslessJson(value);

// The Error branch of the projection copies `name` verbatim, so a non-string
// `name` (which can itself be cyclic or non-JSON) can still reach a result as a
// non-JSON object. Keep the second projection for that exceptional shape,
// without allocating another object graph for ordinary inspect snapshots.
function alreadyLossless(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== "object") return false;
  if (types.isProxy(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (Object.prototype.__lookupGetter__.call(value, String(index))) return false;
        if (index in value && !alreadyLossless(value[index], ancestors)) return false;
      }
      return true;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key in value) {
      if (Object.prototype.__lookupGetter__.call(value, key) || !alreadyLossless(value[key], ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export const name = "dsh-evolution-orchestrator";
export const inject = ["tools", "dynamicCordisRunner", "systemPrompt"];

/**
 * Registration order is the single source of truth for the tool surface: the
 * doctor compares this list against the live registry, so a partially applied
 * plugin is visible instead of silently degraded.
 */
export const EVOLUTION_TOOLS = Object.freeze([
  "evolution_runtime_inspect",
  "evolution_plan",
  "evolution_propose",
  "evolution_trial",
  "evolution_probe",
  "evolution_measure",
  "evolution_revert",
  "evolution_promote",
  "evolution_canary_observe",
  "evolution_history",
  "evolution_maintain",
  "evolution_doctor",
]);

const output = {
  // DSH raw tool schemas accept `{}` as the supported unconstrained-JSON
  // annotation form; `type: "json"` is only valid in author-side parameter
  // specs and fails real registry validation during preset loading.
  schema: {},
  // The rendered text is a session artifact, not a filesystem one: the host keeps
  // the structured `value` for its own consumers and renders this text into the
  // session `tool/result` record, from which the UI shows it and the model
  // re-reads it on every later request. Nothing in that chain parses it by
  // indentation, so the 2-space projection this used to write spent input tokens,
  // on every subsequent turn, on whitespace no consumer reads. The compact
  // projection is the same JSON document - same keys, order and values, and
  // string values that contain whitespace or a stringified document are untouched
  // - so `JSON.parse` of either text yields the same value; only the indentation
  // between tokens is gone (`docs/performance/tool-result-render-compact.md`).
  // It does change what a human reads in a tool-result view, which is the
  // accepted trade for the tokens.
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

const systemText = `
Evolution orchestrates the existing Cordis Runtime: no second registry, resolver,
lifecycle manager, or effect tracker. Cordis owns Component, Service, Fiber,
Effect, event listener, Tool, and Dispose lifecycle; temporary capabilities must
use ctx.effect(), ctx.on(), or an official Cordis disposer. Never turn an
observed error into a permanent rule without a root-cause experiment.

Strict order: evolution_plan (one read-only review: previously published stable
plugins checked against this host, then evidence-ranked candidates from shared
experience and failure memory; it returns an explicit no-action result and starts
no experiment when neither a usable recovery nor a reliable candidate exists),
evolution_runtime_inspect, evolution_propose
(records strategy and rootCause; a strategy already proven ineffective for the
same target and applicability is refused), evolution_probe baseline while
proposed, evolution_trial (Host-only or approval-aware), evolution_probe candidate
after the Trial, evolution_measure, then evolution_revert or evolution_promote.
Evolution runs each fixed probe scenario through the official tool pipeline;

On a self-evolution request (自我进化), start from evolution_plan and follow its
selfEvolution.nextActions in order. A published stable plugin that only needs
revalidation after a host change: run the existing real isolated-host verification
and adopt the evidence with the revalidate command the review names; never edit,
regenerate or re-promote its source. A plugin proven incompatible or failed on the
current host: use the recorded experience for the root cause, propose the smallest
fix with strategy and rootCause, then baseline probe, trial, candidate probe,
measure, and promote or revert. A restart-required consumer: restart that entry
without a source change. An operator action: report the damaged evidence and stop
that item. A "review-retirement" action: a self-contained published plugin has no
persisted workflow invocation and no workflow benefit; report its evidence and the
reversible disable command and wait for the owner. Never disable or delete a
published plugin yourself. An evidence-ranked candidate: use the existing Propose–Probe–Compose
flow and honor a refused proven-ineffective strategy. If nextActions is empty,
report no-action and stop; never invent a plugin, target or benefit. Revalidation
is not a new promotion and changes no source, authorization or gate; every source
change still waits for explicit owner confirmation.
measure derives before/after metrics, sample count, window, repeatability and
regression from the raw samples and ignores caller-supplied metrics when probe
evidence exists. Dispose through Cordis first. Promotion needs every gate
(benefit, measured evidence, repeatability, regression, reversibility, cleanup,
no orphans, runtime recovery) plus explicit owner confirmation; then enters
canary observation until startup, health, dependency, and metric barriers prove
a stable commit; any regression rolls back to last known good. It persists a durable
Plugin row and archive pointer for the next session.

Promotion is Desktop-only unless targetProfiles approves acp/web; only a stable
commit publishes it to those entries, which verify digest, services and host
compatibility before mounting.

Failures, observations and experiment conclusions become bounded canonical
knowledge without a model, with strategy and DSH/Cordis applicability, so a
retry is refused only under the same conditions. Before a Trial, read
experienceRecall from evolution_propose or call evolution_history with query; it
lists resolved problems, failed approaches, and measured candidates. Reuse
resolutions; retry a failed approach only with a new hypothesis and evidence.
Recall is advisory: the gates and owner confirmation still decide.

evolution_maintain is the only capacity operation; an owner action, never a
schedule. Start with dryRun; a real call requires confirmation: true. It refuses
rather than guessing; reclaiming never substitutes for measurement or promotion
gates.
`;

function compositionParameters() {
  return {
    experimentId: { type: "string", required: true },
    idPrefix: { type: "string", description: "Optional 3–6 lowercase prefix for the Host-minted Plugin ID." },
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
// object root. `type: "json"` becomes the supported unconstrained form; a
// description the author declared there still reaches the model.
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
  // An unconstrained value keeps accepting any JSON, but a description the
  // author declared still has to reach the model: the accepted shape of a
  // value is model-facing behavior, not an implementation detail.
  if (schema.type === "json") return schema.description ? { description: schema.description } : {};
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
  // Arrays of structured items are the only nesting the local spec writes, and
  // their `properties` need the same `type: "json"` compilation the object root
  // gets; without this the author-side spelling leaks into the registered schema,
  // where `"json"` is not a valid JSON Schema type. Arrays of scalars project to
  // the identical object, so every previously declared schema is byte-stable.
  if (schema.type === "array") return { ...schema, items: normalizeSchema(schema.items ?? {}) };
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
    // A warning is a durable-looking log line, so it crosses the same boundary
    // as the error text it describes: the raw message never reaches the log.
    const detail = safeErrorDto(error, "startup-drift");
    ctx.logger?.warn?.(`[evolution] startup drift check unavailable: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`);
    return null;
  });
  startupDriftChecks.set(key, check);
  return check;
}

export function apply(ctx, config = {}) {
  const orchestrator = new EvolutionOrchestrator(ctx, config);
  if (config.startupDrift !== false) void ensureStartupDrift(orchestrator, ctx);
  ctx.systemPrompt.section({ name: "tool:evolution-orchestrator", order: 116, text: systemText });
  const registered = [];
  const register = (definition) => {
    const result = ctx.tools.register({
      ...definition,
      parameters: parameterSchema(definition.parameters),
      execute: async (args, exec) => {
        // The durable flush is cleanup of a completed tool call, not part of its
        // own result. When the tool already failed, a flush failure must not
        // replace the reason it failed: the primary error is what the caller and
        // the model need. The flush failure does not disappear - it is written
        // as a redacted diagnostic, because "durability is behind" is a fact the
        // operator has to see. On success the flush error still fails the call,
        // exactly as before.
        let failed = false;
        try {
          return await definition.execute(args, exec);
        } catch (error) {
          failed = true;
          throw redactedToolError(error);
        } finally {
          try { await config.domainStorage?.flush(); }
          catch (error) {
            if (!failed) throw redactedToolError(error, "domain-flush-cleanup");
            warnRedacted(ctx, "domain flush failed after a tool error", error, "domain-flush-cleanup");
          }
        }
      },
    });
    registered.push(definition.name);
    return result;
  };
  register({
    name: "evolution_doctor",
    description: "Model-free health report over package, host, registration, data, state, migration, and promotion facts; reports ok, degraded, or blocked with per-check evidence. repair=true applies only safe, idempotent repairs; restart-only promotion-journal rollback never runs live.",
    parameters: {
      repair: { type: "boolean", description: "Defaults to false (read-only); re-verifies after applying." },
      composition: { type: "boolean", description: "Also dump the composed profile through the official CLI (default true)." },
    },
    output,
    execute: async (args) => losslessResult(await config.diagnose({ repair: args?.repair === true, composition: args?.composition !== false, registeredNames: registered })),
  });
  if (config.domainStorage) register({
    name: 'evolution_history', description: 'Read bounded, non-sensitive history metadata, counts, and metric integration. With query, return bounded experience recall, not rows.',
    parameters: {
      collection: { type: 'string' },
      limit: { type: 'number' },
      query: { type: 'string', description: 'Problem or target text to recall.' },
      target: { type: 'string', description: 'Optional exact-replay target with query.' },
      impactScope: { type: 'array', items: { type: 'string' }, description: 'Optional impact scope with query.' },
    }, output,
    execute: args => args?.query
      ? losslessResult(orchestrator.recallExperience({ problem: args.query, target: args.target, impactScope: args.impactScope }, { limits: { maxEntries: args.limit } }))
      : config.domainStorage.query(args.collection, args.limit),
  });
  if (config.domainStorage) register({
    name: "evolution_maintain", description: "Reclaim absorbed history: fold terminal archive records into aggregate rows (deleting the sealed segments replaced) and discard the consumed authenticated log prefix, pruning its markers behind a durable retention floor, after externalizing their evidence. Refuses rather than guessing: unreadable or conflicting archive evidence, an unreadable log, a pending transaction, or a log that changed mid-planning aborts without discarding anything.",
    parameters: {
      dryRun: { type: "boolean", description: "Report exact counts and bytes without modifying anything." },
      confirmation: { type: "boolean", description: "Required true to delete committed archive segments and authenticated log bytes." },
      archives: { type: "boolean", description: "Reclaim retired archive history (default true)." },
      log: { type: "boolean", description: "Discard the absorbed event-log prefix (default true)." },
      retainRecords: { type: "number", description: "Newest absorbed log records to keep (default 1024, minimum 1)." },
    }, output,
    // `reclaim()` is async: returning it without awaiting made the tool report
    // `{"$class":"Promise"}` (the lossless projection of the promise object),
    // skipped the flush/error handling the wrapper owns, and turned the
    // confirmation refusal into an unhandled rejection.
    execute: async (args) => losslessResult(await (args?.dryRun === true
      ? config.domainStorage.reclaim({ dryRun: true, archives: args?.archives !== false, log: args?.log !== false, retainRecords: args?.retainRecords })
      : config.domainStorage.reclaim({
          confirmation: args?.confirmation === true,
          archives: args?.archives !== false,
          log: args?.log !== false,
          retainRecords: args?.retainRecords,
        }))),
  });
  register({
    name: "evolution_runtime_inspect",
    description: "Inspect the live Cordis Runtime: components, services, tools, dependencies, events, dynamic Plugins, and inspect providers; reads live registries, not a static inventory.",
    parameters: {},
    output,
    // inspect() already returns a detached lossless-JSON snapshot.
    execute: (_args, exec) => {
      const result = orchestrator.inspect(exec.agent);
      return Promise.resolve(alreadyLossless(result) ? result : losslessResult(result));
    },
  });
  register({
    name: "evolution_plan",
    description: "Read-only self-evolution review: previously published stable plugins checked against this host (active, pending-revalidation, incompatible, restart-required, operator-action) plus evidence-ranked Cordis-plugin candidates from shared experience and failure memory, composed into ordered nextActions; returns an explicit no-action result and starts no experiment when no reliable candidate exists.",
    parameters: {
      focus: { type: "string" },
      minOccurrences: { type: "number" },
      limit: { type: "number" },
    },
    output,
    // `plan()` is synchronous and owner-scoped: it reads the shared/domain
    // experience through `exec` but never mutates an experiment.
    execute: async (args, exec) => losslessResult(await orchestrator.reviewSelfEvolution(args, exec)),
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
      strategy: { type: "string", description: "Stable identity of the Cordis-plugin strategy; same target+strategy+applicability that already proved ineffective is refused." },
      rootCause: { type: "string" },
      // Optional, bounded benefit model. "workflow" requires the promotion gate
      // to see a probe-proven workflow before/after; "capability" adds a tool
      // without claiming a workflow fix. Absent keeps the historical contract.
      benefitModel: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["workflow", "capability"] },
          metric: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      // Which verification contract this experiment owes. A "context-policy"
      // improvement changes how an existing step is fed (an event listener that
      // transforms the next step) instead of registering a new tool; it has no
      // capability to self-test, so it must declare a workflow benefit and pass
      // the taskBenefit gate. Absent keeps the historical tool contract.
      improvement: { type: "string", enum: ["tool", "context-policy"] },
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
    description: "Define and activate a temporary Cordis Package for an existing Proposal; the Host Runner owns its lifecycle.",
    parameters: compositionParameters(),
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.trial(args, exec)),
  });
  register({
    name: "evolution_probe",
    description: "Run a fixed scenario through the official tool pipeline and record raw baseline/candidate samples; baseline requires proposed, candidate requires trial; measure derives metrics from the samples. Only tools that opt into the official concurrency-safe contract are allowed; write, shell, delegation, background, scheduling, network, session, unknown and reserved steps are refused upfront.",
    parameters: {
      experimentId: { type: "string", required: true },
      phase: { type: "string", required: true, description: "baseline or candidate" },
      scenario: {
        type: "object",
        required: true,
        properties: {
          id: { type: "string", required: true },
          description: { type: "string" },
          kind: { type: "string", description: "workflow: paired tool paths with identical arguments and expected results." },
          repetitions: { type: "number" },
          steps: {
            type: "array",
            required: true,
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                arguments: { type: "json" },
                role: { type: "string" },
                absentInBaseline: { type: "boolean", description: "Trial capability." },
                candidateName: { type: "string" },
                resultPath: { type: "array", items: { type: "string" } },
                expected: { type: "json" },
              },
            },
          },
        },
      },
    },
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.probe(args, exec)),
  });
  register({
    name: "evolution_measure",
    description: "Record an Observation for a running Trial and evaluate promotion gates.",
    parameters: {
      experimentId: { type: "string", required: true },
      taskId: { type: "string", description: "Desktop task identity the taskBenefit artifact is bound to." },
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
          beforeMetrics: { type: "object", description: "Baseline metrics before the Trial." },
          afterMetrics: { type: "object", description: "Metrics after the observation window." },
          observationWindow: { type: "json", description: "String or positive number window id." },
          sampleCount: { type: "number", description: "Positive sample count backing afterMetrics." },
          benefitEvidence: { type: "string" },
          repeatable: { type: "boolean" },
          regressionPassed: { type: "boolean" },
          reversible: { type: "boolean" },
          cleanupEvidence: { type: "string" },
          taskBenefit: { type: "json", description: "Paired real-session evidence bound to this candidate source; a workflow claim cannot promote without it." },
        },
      },
    },
    output,
    execute: (args, exec) => Promise.resolve(losslessResult(orchestrator.measure(args, exec))),
  });
  register({
    name: "evolution_revert",
    description: "Stop and undefine a temporary Plugin through Cordis, then prove the signature returned to baseline.",
    parameters: { experimentId: { type: "string", required: true } },
    output,
    execute: async (args, exec) => losslessResult(await orchestrator.revert(args, exec)),
  });
  register({
    name: "evolution_promote",
    description: "Prepare, apply, verify a measured Trial as a Host-only Cordis Plugin, then enter canary observation. Set confirmation=true only after reviewing measured evidence and rollback proof; false or omitted returns an owner-confirmation result without mutating production.",
    parameters: {
      experimentId: { type: "string", required: true },
      confirmation: { type: "boolean", description: "Explicit owner confirmation; only true authorizes production. False or omitted is read-only." },
      targetProfiles: {
        type: "array",
        items: { type: "string" },
        description: "Cross-entry approval for acp and web; omitted keeps Desktop-only. ACP/Web load it only after a stable canary commit.",
      },
      canaryVerification: {
        type: "object",
        description: "Optional context-policy functional-check obligation. observations (1..5) raises the per-experiment canary floor; the kernel never lowers its own default. A health-only startup observation cannot satisfy this obligation.",
        properties: {
          tool: { type: "string" },
          arguments: { type: "object" },
          resultPath: { type: "array", items: { type: "string" } },
          expected: {},
          observations: { type: "number" },
        },
      },
      canaryWindow: { type: "number", description: "Optional minimum canary observations for this experiment, 1..5; the kernel takes the larger of this value and its own default." },
    },
    output,
    execute: async (args, exec) => {
      try {
        return losslessResult(await orchestrator.promote(args, exec));
      } catch (error) {
        // A confirmed promotion whose Trial disposal threw before the canary
        // journal was written is a refusal the Desktop host must answer with
        // `evolution_revert`. The kernel keeps the original exception for its
        // direct callers, but neither its custom flags nor a plain Error's code
        // survives the host's tool-error serialization. Publish the refusal as
        // an ordinary receipt instead: the host's non-canary branch already
        // turns that into the same revert/retry path used for other refusals.
        if (args?.confirmation === true && error?.promotionCleanupFailed === true) {
          return losslessResult({
            ok: false,
            experimentId: args.experimentId,
            phase: typeof error.promotionPhase === "string" ? error.promotionPhase : "revert-failed",
            reason: "promotion-cleanup-failed",
            runtimeRecovered: false,
          });
        }
        throw error;
      }
    },
  });
  register({
    name: "evolution_canary_observe",
    description: "Advance a pending promotion canary at a deterministic barrier. Startup, component health, dependencies, and metrics must stay healthy; regression rolls back.",
    parameters: {
      experimentId: { type: "string", required: true },
      startupVerified: { type: "boolean", required: true },
      componentHealth: { type: "string", required: true, description: "Observed health; accepts healthy, active, or ok." },
      dependenciesPresent: { type: "boolean", required: true },
      metricRegression: { type: "boolean", required: true },
      metrics: { type: "object" },
      evidence: { type: "object" },
      verificationKind: { type: "string", enum: ["health", "functional"], description: "Only a functional observation with a matching evidence.functionalCheck can satisfy a canary functional-check obligation." },
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
    let startupCanaryChecked = false;
    let startupCanaryRun = null;
    const ensureStartupCanary = (agent) => {
      if (startupCanaryChecked) return null;
      // Concurrent pre-steps share one verification. The settled flag is only
      // set after it succeeds, and the in-flight promise is cleared on failure,
      // so a later step retries instead of treating a failed check as done.
      if (!startupCanaryRun) {
        startupCanaryRun = (async () => {
          await orchestrator.verifyStartupCanary(agent);
          startupCanaryChecked = true;
        })().finally(() => { startupCanaryRun = null; });
      }
      return startupCanaryRun;
    };
    ctx.on("agent/pre-step", async (payload, next) => {
      const pendingCanary = payload?.agent ? ensureStartupCanary(payload.agent) : null;
      if (pendingCanary) await pendingCanary;
      await config.domainStorage?.flush();
      return next();
    });
    if (config.dailyAutonomousObservation !== false && (orchestrator.autonomous || config.observe === true || config.domainStorage)) {
      // Official 0.2.0 agent/error is emit, NOT a waterfall: it supplies no
      // next callback. Contain async observer failures without affecting the
      // original agent error or silently claiming successful observation.
      ctx.on("agent/error", (payload) => {
        // Every read of the host payload happens inside the contained call: this
        // is an `emit` listener, so a getter that throws (or a property read on a
        // half-built payload) would escape synchronously into the host's own error
        // emission and replace the agent error it was describing. `tools/result`
        // below wraps its reads for the same reason.
        void (async () => {
          if (!payload?.agent) return;
          const error = payload.error;
          // The raw provider message stays on this side of the boundary: the
          // observer receives the safe DTO (code, category, digest, bounded and
          // redacted summary), which is what reaches the failure memory and the
          // inspect output. The digest keeps distinct failures distinct.
          const detail = safeErrorDto(error, "observation", { patternDigest: true });
          const observation = {
            type: "agent/error",
            // The DTO is the only thing this listener reads. Reading `error.code`
            // here again (as this line used to) put a property read back on the
            // failure path after the boundary had already decided the object was
            // readable: a throwing `code` getter aborted the listener
            // synchronously, which is exactly the non-throwing property the DTO
            // exists to provide. `errorCode` is the same value the DTO read, and
            // the fallback is unchanged.
            code: detail.errorCode || "AGENT_ERROR",
            message: detail.errorSummary,
            errorCategory: detail.errorCategory,
            errorDigest: detail.errorDigest,
            errorPatternDigest: detail.errorPatternDigest,
            target: "agent",
          };
          return orchestrator.observeAutonomous(observation, {
            agent: payload.agent,
            signal: payload.signal || new AbortController().signal,
          });
        })().catch(error => {
          warnRedacted(ctx, "agent error observer failed", error);
        });
      });
      // Official 0.2.0 dsh-tools publishes `tools/result` through
      // `events.dispatch("emit", …)` in `notifyResult()`, with no `next`
      // argument, after the outcome has been materialized and frozen. It is an
      // emit, not a waterfall: nothing this listener returns can replace,
      // mutate or delay the tool result, so the observer is a pure side path.
      // The registry already catches a thrown or rejected observer — but it
      // reports it through `errorMessage(error)`, i.e. the raw message. Contain
      // the observer here for the same reason `agent/error` is contained above:
      // an observation failure must not reach that raw log, and the plugin's own
      // diagnostic has to be the redacted DTO. The guard reads run inside the
      // containment too, so no read on this path can escape uncontained. Both
      // The observer commits its observation before counting evidence or making
      // a decision; a failing domain write still stops the decision path.
      ctx.on("tools/result", (exec, result) => {
        void (async () => {
          if (!result?.isError || !exec?.agent || isVerificationCall(exec) || String(exec.name || "").startsWith("evolution_")) return;
          // Read the identifier through the same boundary the lightweight
          // collector uses: the official failure code is `error.info.code`, not
          // the legacy top-level `result.code` this entry used to read. A wrong
          // code here produced `TOOL_<name>` attribution and a different pattern
          // identity than the experience store recorded for the same failure.
          const failureCode = toolFailureCode(result);
          const safeObservation = { type: 'tool/error', code: failureCode, target: `tool:${exec.name}` };
          // The pattern identity is the *shape* of the failure the host
          // published, not the bytes it materialized. Hashing the whole result
          // made every instance its own pattern, so one root cause whose text
          // carries a path, an id or a duration never accumulated to
          // `patternThreshold` (see `toolFailurePatternDigest`).
          const patternDigest = toolFailurePatternDigest(result);
          // The observation input is a bounded telemetry row that reaches the
          // observation stream, `inspect`, the failure memory and the evidence
          // sidecar. The execution context is the second argument, not part of
          // it: passing `agent` here copied the host's session object (its title,
          // its transcript, its options) across that boundary.
          return orchestrator.observeAutonomous({
            type: "tool/error",
            code: failureCode || `TOOL_${String(exec.name || "UNKNOWN").toUpperCase()}`,
            message: `Official operation failed (${safeObservation.code || "HOST_OPERATION_FAILED"})`,
            target: `tool:${exec.name}`,
            // Exact evidence: the complete materialized result, as before, so a
            // record made before this projection existed still reproduces its own
            // identity through `patternKey`'s read-only legacy path.
            errorDigest: safeErrorDto(JSON.stringify(result), "observation").errorDigest,
            ...(patternDigest ? { errorPatternDigest: patternDigest } : {}),
          }, { agent: exec.agent, signal: exec.signal || new AbortController().signal });
        })().catch((error) => {
          warnRedacted(ctx, "tool result observer failed", error);
        });
      });
    }
  }
  return orchestrator;
}

export { EvolutionOrchestrator } from "./orchestrator.js";
