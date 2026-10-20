import { ValidationError } from "./errors.js";
export const COMPONENT_CONTRACT_KINDS = Object.freeze([
  "agent",
  "tool",
  "skill",
  "plugin",
  "provider",
  "evolution.strategy",
  "evolution.stage",
  "component",
]);
function clone(value) { if (value === undefined || value === null) return value; try { return structuredClone(value); } catch { if (Array.isArray(value)) return value.map(clone); if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])); return typeof value === "function" ? undefined : value; } }
/** Numeric version components, as the major-change check reads them. */
function versionParts(value) { const parsed = parseVersion(value); return parsed ? [parsed.major, parsed.minor, parsed.patch] : [0, 0, 0]; }
const EMPTY_VERSION = Object.freeze({ major: 0, minor: 0, patch: 0, prerelease: [], parts: 0 });
/**
 * One semantic version, or null when the text is not one. A component that is
 * not written counts as 0 and `parts` remembers how many were written, because
 * `^` and `~` widen a two-part requirement differently from a three-part one.
 * Build metadata is parsed away; semver precedence never reads it.
 */
function parseVersion(value) { const text = String(value ?? "").trim().replace(/^v/i, ""); const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/); if (!match) return null; return { major: Number(match[1]), minor: match[2] === undefined ? 0 : Number(match[2]), patch: match[3] === undefined ? 0 : Number(match[3]), prerelease: match[4] === undefined ? [] : match[4].split("."), parts: match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1 }; }
function coerceVersion(value) { return parseVersion(value) ?? EMPTY_VERSION; }
function compareIdentifiers(left, right) { const leftNumeric = /^\d+$/.test(left); const rightNumeric = /^\d+$/.test(right); if (leftNumeric && rightNumeric) return Number(left) - Number(right); if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1; return left < right ? -1 : left > right ? 1 : 0; }
/** Semver precedence: major, minor, patch, then prerelease (a release sorts above one). */
function compareParsedVersions(left, right) { for (const key of ["major", "minor", "patch"]) { const delta = left[key] - right[key]; if (delta !== 0) return delta; } if (!left.prerelease.length || !right.prerelease.length) return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1; for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) { if (left.prerelease[index] === undefined) return -1; if (right.prerelease[index] === undefined) return 1; const delta = compareIdentifiers(left.prerelease[index], right.prerelease[index]); if (delta !== 0) return delta; } return 0; }
function compareVersions(left, right) { return compareParsedVersions(coerceVersion(left), coerceVersion(right)); }
/** The exclusive upper bound `^target` denotes. */
function ceilingVersion(major, minor, patch) { return { major, minor, patch, prerelease: [], parts: 3 }; }
function caretCeiling(target) { if (target.major > 0) return ceilingVersion(target.major + 1, 0, 0); if (target.parts === 1) return ceilingVersion(1, 0, 0); if (target.parts === 2 || target.minor > 0) return ceilingVersion(0, target.minor + 1, 0); return ceilingVersion(0, 0, target.patch + 1); }
/** The exclusive upper bound `~target` denotes. */
function tildeCeiling(target) { return target.parts === 1 ? ceilingVersion(target.major + 1, 0, 0) : ceilingVersion(target.major, target.minor + 1, 0); }
function clauseMatches(version, clause) {
  // An unparsable comparator target behaves as 0.0.0, which is what this module
  // has always compared it as.
  const target = clause.target ?? EMPTY_VERSION;
  const comparison = compareParsedVersions(version, target);
  if (clause.operator === ">=") return comparison >= 0;
  if (clause.operator === "<=") return comparison <= 0;
  if (clause.operator === ">") return comparison > 0;
  if (clause.operator === "<") return comparison < 0;
  if (clause.operator === "^") return comparison >= 0 && compareParsedVersions(version, caretCeiling(target)) < 0;
  if (clause.operator === "~") return comparison >= 0 && compareParsedVersions(version, tildeCeiling(target)) < 0;
  return comparison === 0;
}
export function satisfiesVersionRequirement(version, requirement) { if (requirement === undefined || requirement === null || requirement === "" || requirement === "*") return true; if (requirement && typeof requirement === "object") { if (requirement.exact !== undefined && !satisfiesVersionRequirement(version, requirement.exact)) return false; if (requirement.min !== undefined && compareVersions(version, requirement.min) < 0) return false; if (requirement.max !== undefined && compareVersions(version, requirement.max) > 0) return false; return true; } const range = String(requirement).trim(); if (range === "*") return true; if (range.includes("||")) return range.split("||").some((part) => satisfiesVersionRequirement(version, part.trim())); const clauses = range.split(/\s+/).filter(Boolean).map((clause) => { const match = clause.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/); return { operator: match?.[1] ?? "=", target: parseVersion(match?.[2] ?? clause) }; }); if (!clauses.length) return true; const parsed = coerceVersion(version); if (!clauses.every((clause) => clauseMatches(parsed, clause))) return false; // npm's prerelease rule: a prerelease only satisfies a comparator set that
// names a prerelease for the same major.minor.patch.
if (!parsed.prerelease.length) return true; return clauses.some((clause) => clause.target?.prerelease.length && clause.target.major === parsed.major && clause.target.minor === parsed.minor && clause.target.patch === parsed.patch); }
function dependency(value) { if (typeof value === "string") return { id: value, versionRange: "*", optional: false }; if (!value || typeof value !== "object") throw new ValidationError("Component contract dependency must be a string or object"); const id = value.id ?? value.componentId ?? value.name ?? value.capability; if (!id) throw new ValidationError("Component contract dependency requires name, id, or capability"); return { name: String(value.name ?? id), id: String(id), ...(value.capability ? { capability: String(value.capability) } : {}), versionRange: value.versionRange ?? value.range ?? value.version ?? "*", optional: Boolean(value.optional) }; }
export function normalizeComponentContract(input = {}) {
  if (!input || typeof input !== "object") throw new ValidationError("Component contract is required");
  const identity = input.identity && typeof input.identity === "object" ? input.identity : {};
  const id = String(input.id ?? identity.id ?? input.name ?? identity.name ?? "");
  const name = input.name ?? identity.name ?? id;
  if (!name) throw new ValidationError("Component contract requires a name or id");
  const version = String(input.version ?? identity.version ?? "0.0.0");
  const kind = String(input.kind ?? input.type ?? "component").toLowerCase();
  const requires = input.requires ?? input.dependencies ?? input.dependencyRequirement ?? [];
  const dependencies = (Array.isArray(requires) ? requires : [requires]).filter(Boolean).map(dependency);
  const capabilities = unique(input.capabilities ?? []);
  const provides = unique([
    ...(Array.isArray(input.provides) ? input.provides : input.provides ? [input.provides] : []),
    ...capabilities,
  ]);
  const migration = input.migration ?? input.migrate ?? null;
  const compatibility = input.compatibility && typeof input.compatibility === "object" ? input.compatibility : {};
  const lifecycle = input.lifecycle && typeof input.lifecycle === "object" ? clone(input.lifecycle) : {};
  const effects = clone(Array.isArray(input.effects) ? input.effects : input.effects ? [input.effects] : []);
  const apiVersion = compatibility.apiVersion ?? input.apiVersion ?? "1.0.0";
  return {
    // The flat fields are the stable Spatial Component Contract surface.
    id,
    name: String(name),
    kind,
    version,
    apiVersion: String(apiVersion),
    capabilities,
    requires: dependencies.map(clone),
    provides,
    lifecycle,
    effects,
    dependencies,
    migration: {
      supported: Boolean(migration && (migration.supported ?? migration.from ?? migration.strategy ?? typeof migration === "function")),
      ...(migration && typeof migration === "object" ? clone(migration) : {}),
    },
    compatibility: {
      apiVersion: String(apiVersion),
      ...(compatibility.hostVersion ?? input.hostVersion ? { hostVersion: compatibility.hostVersion ?? input.hostVersion } : {}),
      ...(compatibility.interface ?? input.interface ? { interface: String(compatibility.interface ?? input.interface) } : {}),
    },
  };
}
function unique(values) { return [...new Set((Array.isArray(values) ? values : [values]).filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map(String))]; }
function providedNames(definition) { const declared = definition?.provides ?? definition?.capabilities ?? []; return new Set((Array.isArray(declared) ? declared : [declared]).filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map((value) => String(value).trim())); }
function availableMatches(dependencySpec, available) { const required = [dependencySpec.id, dependencySpec.capability].filter((value) => value !== undefined && value !== null && String(value).trim() !== "").map((value) => String(value).trim()); return available.some((entry) => { const definition = entry?.definition ?? entry; const id = definition?.id ?? definition?.name ?? definition?.identity?.name; const provided = providedNames(definition); if (id !== undefined && id !== null) provided.add(String(id).trim()); const identityMatch = required.some((name) => provided.has(name)); return identityMatch && satisfiesVersionRequirement(definition?.version ?? definition?.identity?.version, dependencySpec.versionRange); }); }
export function checkComponentCompatibility(input, { hostVersion = null, apiVersion = null, previous = null, availableComponents = [], supportedKinds = null } = {}) { const contract = input?.dependencies && input?.migration && input?.compatibility ? input : normalizeComponentContract(input); const reasons = []; if (supportedKinds && !supportedKinds.map(String).includes(contract.kind)) reasons.push("unsupported component kind: " + contract.kind); if (hostVersion && contract.compatibility.hostVersion && !satisfiesVersionRequirement(hostVersion, contract.compatibility.hostVersion)) reasons.push("host version is outside the component contract"); if (apiVersion && contract.compatibility.apiVersion && String(apiVersion) !== String(contract.compatibility.apiVersion)) reasons.push("component API version is incompatible"); for (const requirement of contract.dependencies) if (!requirement.optional && !availableMatches(requirement, availableComponents)) reasons.push("missing dependency: " + requirement.id); if (previous) { const previousContract = normalizeComponentContract(previous); const majorChanged = versionParts(previousContract.version)[0] !== versionParts(contract.version)[0]; if (majorChanged && !contract.migration.supported) reasons.push("major version change requires migration capability"); } return { compatible: reasons.length === 0, reasons, contract: clone(contract) }; }
export function createComponentContract(input = {}) { return normalizeComponentContract(input); }
