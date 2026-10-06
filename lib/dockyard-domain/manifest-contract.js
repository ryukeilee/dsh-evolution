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
function versionParts(value) { return String(value ?? "0.0.0").replace(/^v/i, "").split(/[.+-]/)[0].split(".").map((part) => Number.parseInt(part, 10) || 0); }
function compareVersions(left, right) { const a = versionParts(left); const b = versionParts(right); for (let index = 0; index < 3; index += 1) { const delta = (a[index] ?? 0) - (b[index] ?? 0); if (delta !== 0) return delta; } return 0; }
export function satisfiesVersionRequirement(version, requirement) { if (requirement === undefined || requirement === null || requirement === "" || requirement === "*") return true; if (requirement && typeof requirement === "object") { if (requirement.exact !== undefined && !satisfiesVersionRequirement(version, requirement.exact)) return false; if (requirement.min !== undefined && compareVersions(version, requirement.min) < 0) return false; if (requirement.max !== undefined && compareVersions(version, requirement.max) > 0) return false; return true; } const range = String(requirement).trim(); if (range.includes("||")) return range.split("||").some((part) => satisfiesVersionRequirement(version, part.trim())); return range.split(/\s+/).filter(Boolean).every((clause) => { const match = clause.match(/^(\^|~|>=|<=|>|<|=)?(.*)$/); const operator = match?.[1] ?? "="; const target = match?.[2] ?? clause; const comparison = compareVersions(version, target); if (operator === ">=") return comparison >= 0; if (operator === "<=") return comparison <= 0; if (operator === ">") return comparison > 0; if (operator === "<") return comparison < 0; if (operator === "^") return comparison >= 0 && compareVersions(version, (versionParts(target)[0] + 1) + ".0.0") < 0; if (operator === "~") return comparison >= 0 && compareVersions(version, versionParts(target)[0] + "." + (versionParts(target)[1] + 1) + ".0") < 0; return comparison === 0; }); }
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
function availableMatches(dependencySpec, available) { return available.some((entry) => { const definition = entry?.definition ?? entry; const id = definition?.id ?? definition?.name ?? definition?.identity?.name; const provides = definition?.provides ?? definition?.capabilities ?? []; const identityMatch = id === dependencySpec.id || provides.includes(dependencySpec.id) || provides.includes(dependencySpec.capability); return identityMatch && satisfiesVersionRequirement(definition?.version ?? definition?.identity?.version, dependencySpec.versionRange); }); }
export function checkComponentCompatibility(input, { hostVersion = null, apiVersion = null, previous = null, availableComponents = [], supportedKinds = null } = {}) { const contract = input?.dependencies && input?.migration && input?.compatibility ? input : normalizeComponentContract(input); const reasons = []; if (supportedKinds && !supportedKinds.map(String).includes(contract.kind)) reasons.push("unsupported component kind: " + contract.kind); if (hostVersion && contract.compatibility.hostVersion && !satisfiesVersionRequirement(hostVersion, contract.compatibility.hostVersion)) reasons.push("host version is outside the component contract"); if (apiVersion && contract.compatibility.apiVersion && String(apiVersion) !== String(contract.compatibility.apiVersion)) reasons.push("component API version is incompatible"); for (const requirement of contract.dependencies) if (!requirement.optional && !availableMatches(requirement, availableComponents)) reasons.push("missing dependency: " + requirement.id); if (previous) { const previousContract = normalizeComponentContract(previous); const majorChanged = versionParts(previousContract.version)[0] !== versionParts(contract.version)[0]; if (majorChanged && !contract.migration.supported) reasons.push("major version change requires migration capability"); } return { compatible: reasons.length === 0, reasons, contract: clone(contract) }; }
export function createComponentContract(input = {}) { return normalizeComponentContract(input); }
