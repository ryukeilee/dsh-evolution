import { randomUUID } from "node:crypto";
import { MutationAuthorityError } from "./mutation-authority.js";
export function clone(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return typeof value === "function" ? undefined : value;
  }
}

export function readonlyProjection(value, label = "governance state") {
  const error = () => new MutationAuthorityError(`${label}.projection`);
  const seen = new WeakMap();
  const protect = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry instanceof Date) return new Date(entry.getTime());
    if (seen.has(entry)) return seen.get(entry);
    const target = Array.isArray(entry) ? [] : {};
    const projection = new Proxy(target, {
      set() { throw error(); },
      defineProperty() { throw error(); },
      deleteProperty() { throw error(); },
    });
    seen.set(entry, projection);
    for (const key of Reflect.ownKeys(entry)) {
      if (Array.isArray(target) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
      Object.defineProperty(target, key, {
        value: protect(descriptor.value), enumerable: descriptor.enumerable,
        configurable: true, writable: true,
      });
    }
    return projection;
  };
  return protect(value);
}

export function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function id(prefix) {
  return `${prefix}:${Date.now().toString(36)}:${randomUUID()}`;
}

const SENSITIVE_KEY_PARTS = Object.freeze(["accesstoken", "refreshtoken", "token", "secret", "credential", "apikey", "password"]);

export function redact(value, key = "", seen = new WeakSet()) {
  if (typeof key === "string" && SENSITIVE_KEY_PARTS.some((needle) => key.toLowerCase().includes(needle))) return undefined;
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function") return undefined;
  if (typeof value !== "object") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, "", seen)).filter((entry) => entry !== undefined);
  const output = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    const normalized = redact(entry, entryKey, seen);
    if (normalized !== undefined) output[entryKey] = normalized;
  }
  return output;
}

export function safeRecord(value = {}) {
  const normalized = redact(value);
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) return normalized;
  return {};
}

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
}

export function clamp01(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return null;
  return Math.min(1, Math.max(0, Number(value)));
}

