/**
 * The only code identity that DSH must never rewrite is Cordis itself.
 *
 * DSH components are intentionally not listed here.  They remain evolvable
 * by default and are protected by lifecycle, isolation, evidence, rollback,
 * and explicit promotion gates instead of a permanent code deny-list.
 */

export const CORDIS_TRUST_ROOT = Object.freeze({
  id: "cordis",
  packageNames: Object.freeze([
    "@deepseek-ai/cordis",
    "@deepseek-ai/cordis-plugin-loader",
    "@deepseek-ai/cordis-plugin-include",
  ]),
  areas: Object.freeze([
    "core",
    "effect",
    "coeffect",
    "component-lifecycle",
    "loader",
    "recovery",
  ]),
});

export const CORDIS_TRUST_ROOT_TARGETS = Object.freeze([
  "cordis",
  "cordis.core",
  "cordis.effect",
  "cordis.coeffect",
  "cordis.component-lifecycle",
  "cordis.loader",
  "cordis.recovery",
  ...CORDIS_TRUST_ROOT.packageNames,
]);

const CORDIS_PACKAGE_PATH_RE = /(?:^|[\\/])@deepseek-ai[\\/]cordis(?:[\\/]|$)/i;
const CORDIS_PLUGIN_PATH_RE = /(?:^|[\\/])@deepseek-ai[\\/]cordis-plugin-(?:loader|include)(?:[\\/]|$)/i;
const CORDIS_TARGET_RE = /^(?:@deepseek-ai[\\/]?)?cordis(?:$|[.:/_-](?:core|effect|coeffect|component(?:[-_]?lifecycle)?|lifecycle|loader|recovery|trust[-_]?root))(?:[.:/_-]|$)/i;
const CORDIS_AREA_RE = /(?:^|[.:/_-])cordis(?:[.:/_-](?:core|effect|coeffect|component(?:[-_]?lifecycle)?|lifecycle|loader|recovery|trust[-_]?root))(?:[.:/_-]|$)/i;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Return true only for an explicit Cordis package/area identity. */
export function isCordisTrustRoot(value) {
  const candidate = text(value);
  if (!candidate) return false;
  return CORDIS_PACKAGE_PATH_RE.test(candidate)
    || CORDIS_PLUGIN_PATH_RE.test(candidate)
    || CORDIS_TARGET_RE.test(candidate)
    || CORDIS_AREA_RE.test(candidate);
}

/**
 * Targets are normally strings, but accepting common target records keeps the
 * boundary check useful for proposal/effect metadata without scanning prose.
 */
export function isCordisTrustRootTarget(target) {
  if (isCordisTrustRoot(target)) return true;
  if (!target || typeof target !== "object") return false;
  const fields = ["target", "targetId", "componentId", "filePath", "path", "module", "package", "packageName", "source", "id"];
  return fields.some((field) => isCordisTrustRoot(target[field]));
}

const HIGH_TRUST_DSH_TARGET_RE = /(?:^|[.:/_-])(?:dsh[-_.])?(?:evolution(?:[-_.](?:engine|orchestrator|policy|control[-_.]?plane|scheduler|recovery|memory|context|routing|ptc))?|orchestrator|control[-_.]?plane|guard(?:[-_.](?:authority|policy|run[-_.]?code|edit|composition))?|scheduler|ptc|tool[-_.]?bridge|model[-_.]?routing|runtime[-_.]?dsh)(?:[.:/_-]|$)/i;

/** Control-plane targets get stricter evidence gates, but are still replaceable. */
export function isHighTrustDshTarget(target) {
  if (isCordisTrustRootTarget(target)) return false;
  const candidate = text(target && typeof target === "object" ? target.target ?? target.id ?? target.componentId : target);
  return Boolean(candidate && HIGH_TRUST_DSH_TARGET_RE.test(candidate));
}

export const REAL_IRREVERSIBLE_RISK_TOKENS = Object.freeze([
  "credential",
  "credentials",
  "api-key",
  "api-keys",
  "apikey",
  "apikeys",
  "keychain",
  "secret",
  "secrets",
  "user-data",
  "delete-user-data",
  "git-reset-hard",
  "git-clean",
  "force-push",
  "publish",
  "deploy",
  "upload-sensitive",
  "bypass-cordis-lifecycle",
  "cordis-lifecycle-bypass",
  "production-replace",
  "production-replacement",
  "production-promote",
  "production-promotion",
]);

function normalizedRiskText(value) {
  return text(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function containsIrreversibleRisk(value) {
  const candidate = normalizedRiskText(value);
  if (!candidate) return false;
  return REAL_IRREVERSIBLE_RISK_TOKENS.some((token) => {
    const normalizedToken = normalizedRiskText(token);
    return candidate === normalizedToken
      || candidate.startsWith(`${normalizedToken}-`)
      || candidate.endsWith(`-${normalizedToken}`)
      || candidate.includes(`-${normalizedToken}-`);
  });
}
