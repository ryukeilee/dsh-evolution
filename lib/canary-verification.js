// Shared, pure canary functional-check descriptor. The kernel and the Desktop
// task host must derive the same binding digest: the kernel persists it in the
// promotion journal, and the host needs it before promotion (for crash recovery)
// and again when replaying after a restart. Keeping one serializer here avoids
// two byte-level definitions of the same fact.
import crypto from 'node:crypto';

export const CANARY_FUNCTIONAL_TOOLS = Object.freeze(['read', 'glob', 'grep']);

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
  const args = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
    ? input.arguments : {};
  const resultPath = Array.isArray(input.resultPath) && input.resultPath.length <= 8
    && input.resultPath.every((key) => typeof key === "string" && key.length <= 100)
    ? input.resultPath : [];
  const expected = input.expected ?? null;
  // The Desktop task protocol already bounds arguments (4 KiB) and expected
  // (16 KiB). Refuse anything larger rather than silently normalizing a
  // different fact into the same binding.
  if (stableJson(args).length > 8192 || stableJson(expected).length > 32768) return null;
  const observations = Number.isSafeInteger(input.observations) && input.observations >= 1 && input.observations <= 5
    ? input.observations : null;
  if (observations === null) return null;
  return { kind: "functional-check", tool, bindingDigest: canaryVerificationDigest({ tool, args, resultPath, expected }), requiredObservations: observations };
}
