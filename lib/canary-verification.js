// Shared, pure canary functional-check descriptor. The kernel and the Desktop
// task host must derive the same binding digest: the kernel persists it in the
// promotion journal, and the host needs it before promotion (for crash recovery)
// and again when replaying after a restart. Keeping one serializer here avoids
// two byte-level definitions of the same fact.
import crypto from 'node:crypto';

export const CANARY_FUNCTIONAL_TOOLS = Object.freeze(['read', 'glob', 'grep']);

// Bounded, lossless JSON validation. A fixed depth marker must never be folded
// into a binding: two different deep values would then share one digest.
function isLosslessValue(value, depth = 0, seen = new Set()) {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const ok = Array.isArray(value)
    ? value.every((item) => isLosslessValue(item, depth + 1, seen))
    : Object.keys(value).every((key) => isLosslessValue(value[key], depth + 1, seen));
  seen.delete(value);
  return ok;
}

function stableJson(value, depth = 0) {
  if (depth > 24) return '"[max-depth]"';
  if (Array.isArray(value)) return `[${Array.from(value, (item) => stableJson(item, depth + 1)).join(",")}]`;
  if (value === undefined) return '"[undefined]"';
  if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
  if (typeof value === "number" && Object.is(value, -0)) return JSON.stringify("-0");
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
}

export function canaryVerificationDigest({ tool, args, resultPath, expected }) {
  return crypto.createHash("sha256").update(stableJson({ tool, arguments: args, resultPath, expected })).digest("hex");
}

/** Validate and normalize an owner-declared functional check into its durable obligation. */
export function normalizeCanaryVerification(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const tool = typeof input.tool === "string" && CANARY_FUNCTIONAL_TOOLS.includes(input.tool) ? input.tool : null;
  if (!tool) return null;
  if (input.resultPath !== undefined && (!Array.isArray(input.resultPath) || input.resultPath.length > 8
    || input.resultPath.some((key) => typeof key !== "string" || key.length > 100))) return null;
  const args = input.arguments === undefined ? {}
    : input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments) ? input.arguments : null;
  const resultPath = input.resultPath ?? [];
  const expected = input.expected ?? null;
  // Reject malformed, deep or oversized descriptors instead of folding them
  // into a lossy canonical form that could collide with a different check.
  if (args === null || !isLosslessValue(args) || !isLosslessValue(expected) || !isLosslessValue(resultPath)) return null;
  if (stableJson(args).length > 8192 || stableJson(expected).length > 32768) return null;
  const observations = Number.isSafeInteger(input.observations) && input.observations >= 1 && input.observations <= 5
    ? input.observations : null;
  if (observations === null) return null;
  const descriptor = { tool, arguments: args, resultPath, expected };
  return {
    kind: "functional-check",
    tool,
    descriptor,
    bindingDigest: canaryVerificationDigest({ tool, args, resultPath, expected }),
    requiredObservations: observations,
  };
}
