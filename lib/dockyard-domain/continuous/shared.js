/** Shared data-safety and deterministic value helpers. */

const SENSITIVE_PARTS = ["credential", "secret", "password", "apikey", "access_token", "refresh_token"];

export function clone(value) {
  if (value === undefined || value === null) return value;
  try { return structuredClone(value); } catch {
    if (Array.isArray(value)) return value.map(clone);
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
    return typeof value === "function" ? undefined : value;
  }
}

export function safeValue(value, key = "", seen = new WeakSet(), depth = 0) {
  if (depth > 7) return "[depth-limited]";
  if (typeof key === "string" && SENSITIVE_PARTS.some((part) => key.toLowerCase().includes(part))) return undefined;
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "string") return value.slice(0, 2000);
    return value;
  }
  if (typeof value === "function") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, code: value.code ?? null };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => safeValue(entry, "", seen, depth + 1)).filter((entry) => entry !== undefined);
  const output = {};
  for (const [entryKey, entry] of Object.entries(value).slice(0, 100)) {
    const normalized = safeValue(entry, entryKey, seen, depth + 1);
    if (normalized !== undefined) output[entryKey] = normalized;
  }
  return output;
}

export function safeRecord(value) {
  const normalized = safeValue(value ?? {});
  return normalized && typeof normalized === "object" && !Array.isArray(normalized) ? normalized : {};
}

export function timestamp(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function finite(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clamp01(value, fallback = 0) {
  const number = finite(value);
  return number === null ? fallback : Math.max(0, Math.min(1, number));
}

export function hash(value) {
  let result = 2166136261;
  for (const character of String(value ?? "")) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

export function nowMs(value, fallback = Date.now()) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}
