import { ValidationError } from "../errors.js";
import { safeRecord, slugify, timestamp } from "./helpers.js";
export const CAPABILITY_GAP_KINDS = Object.freeze([
  "repeated_manual_operation",
  "high_frequency_failure",
  "missing_tool_capability",
  "performance_bottleneck",
]);

export function capabilitySignature(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function classifyGapKind(samples = []) {
  const types = samples.map((entry) => String(entry.type ?? "")).join("|").toLowerCase();
  const codes = samples.map((entry) => String(entry.errorCode ?? entry.code ?? "")).join("|").toLowerCase();
  if (/(^|\|)performance\/(metric|latency|resource)/.test(types)) return CAPABILITY_GAP_KINDS[3];
  if (/user_correction|manual/.test(`${types} ${codes}`)) return CAPABILITY_GAP_KINDS[0];
  if (/not_found|missing|unavailable|no_provider|resolver_not_found|provider_capability_unavailable|tool\/error/.test(`${types} ${codes}`)) {
    return CAPABILITY_GAP_KINDS[2];
  }
  if (/fail|error|retry|abnormal|degraded/.test(types)) return CAPABILITY_GAP_KINDS[1];
  return CAPABILITY_GAP_KINDS[1];
}

/** 从 observation 列表发现能力缺口：重复模式 + 分类，不足阈值返回 null。 */
export function detectCapabilityGap(observations = [], { minOccurrences = 3 } = {}) {
  const groups = new Map();
  for (const observation of observations ?? []) {
    if (!observation || typeof observation !== "object") continue;
    const key = String(observation.patternKey ?? `${observation.type ?? "event"}:${observation.errorCode ?? observation.code ?? observation.message ?? ""}`).toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  let best = null;
  for (const [patternKey, samples] of groups.entries()) {
    if (samples.length < minOccurrences) continue;
    const kind = classifyGapKind(samples);
    const confidence = Math.min(1, samples.length / (minOccurrences * 2));
    const candidate = {
      kind,
      patternKey,
      problem: String(samples[0]?.problem ?? samples[0]?.message ?? patternKey),
      occurrences: samples.length,
      confidence: Math.round(confidence * 100) / 100,
      evidence: samples.slice(0, 5).map((entry) => safeRecord(entry)),
      suggestedCapability: {
        id: slugify(patternKey).slice(0, 48) || "capability-gap",
        type: kind === CAPABILITY_GAP_KINDS[2] ? "tool" : kind === CAPABILITY_GAP_KINDS[3] ? "optimizer" : "automation",
      },
      detectedAt: timestamp(),
    };
    if (!best || candidate.confidence > best.confidence
      || (candidate.confidence === best.confidence && candidate.occurrences > best.occurrences)) best = candidate;
  }
  return best;
}

export function declarativeDefinitionSubset(definition = {}) {
  const source = definition.definition ?? definition;
  return safeRecord({
    id: source.id,
    name: source.name,
    kind: source.kind ?? "component",
    version: source.version,
    provides: source.provides,
    requires: source.requires,
    configuration: source.configuration,
    policy: source.policy,
    metadata: source.metadata,
  });
}


/** Declaration only; not a genesis execution engine or behavioral test proof. */
export function planExperimentalPlugin({ gap, definition = {}, version = "0.1.0", existing = null, blockers = [], clock = () => new Date() } = {}) {
  if (!CAPABILITY_GAP_KINDS.includes(gap?.kind)) throw new ValidationError("Genesis requires a classified capability gap");
  if (blockers.length) throw new ValidationError("Refusing to recreate a plugin that previously failed", { blockers });
  if (existing && ["active", "promoted", "removed"].includes(existing.lifecycleState)) throw new ValidationError("Refusing to overwrite a production or removed plugin");
  const capabilityId = slugify(definition.id ?? gap.suggestedCapability?.id);
  if (!capabilityId || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new ValidationError("Experimental manifest requires id and semantic version");
  return {
    manifest: {
      manifestVersion: 1, id: capabilityId, name: definition.name ?? capabilityId,
      type: gap.suggestedCapability?.type ?? "tool", version, lifecycle: "experimental",
      gap: safeRecord({ kind: gap.kind, patternKey: gap.patternKey, occurrences: gap.occurrences }),
      signature: capabilitySignature(gap.patternKey ?? gap.problem), createdAt: timestamp(clock),
      entry: "definition.json", tests: "plugin.test.mjs",
      rollback: { mechanism: "host-lifecycle-compensation + immutable-artifact-archive" },
    },
    definition: declarativeDefinitionSubset(definition),
    dependencies: (definition.requires ?? []).map((entry) => typeof entry === "string" ? entry : entry?.capability).filter(Boolean).map(String),
    requiredPorts: ["ArtifactResolver", "HostLifecycle", "Evidence", "Persistence", "Authority"],
  };
}
