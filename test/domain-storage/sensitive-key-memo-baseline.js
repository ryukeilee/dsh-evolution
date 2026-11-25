// Reverse the bounded `isSensitiveKey()` memo round before every older pinned
// baseline. The memo is a pure-function cache over string keys, so the reversal
// only has to turn it back into the compute-every-time function; the exact
// single-occurrence anchor fails on any shape drift instead of silently
// reconstructing something else, and the caller's own pin verifies the result.
import assert from "node:assert/strict";

const POST = `/**
 * \`isSensitiveKey()\` is a pure function of its key string, and \`redact()\` asks
 * it about the same small set of field names (plus the empty array key) on
 * every record it walks. Remembering the answer removes a lower-case allocation
 * and an eight-needle scan from that per-field hot path.
 *
 * The cache is bounded because keys come from the payload being redacted and a
 * caller can supply arbitrarily many distinct ones; FIFO eviction keeps the
 * resident set at \`SENSITIVE_KEY_CACHE_MAX\` entries. Only primitive strings are
 * cached: \`String(key)\` on a non-string can run user code or be stateful, so
 * those inputs keep the original compute-every-time path and the exact answer
 * they had before. A \`Map\` is used rather than an object so keys such as
 * \`__proto__\` stay ordinary entries, and a cache value is always a boolean
 * (never \`undefined\`), so a hit can be detected with \`!== undefined\`.
 *
 * A key is remembered only when it is short enough to be a field name. The
 * entry count alone is not a memory bound: the map stores the caller's string,
 * and a payload can carry a few hundred distinct multi-hundred-kilobyte names.
 * Those are classified on the compute path and never retained; a real schema
 * name is far below \`SENSITIVE_KEY_CACHE_KEY_MAX\`, so the hit rate is
 * unaffected while the worst-case retained bytes stay
 * \`SENSITIVE_KEY_CACHE_MAX * SENSITIVE_KEY_CACHE_KEY_MAX\` characters.
 */
const SENSITIVE_KEY_CACHE_MAX = 512;
const SENSITIVE_KEY_CACHE_KEY_MAX = 128;
const sensitiveKeyCache = new Map();

function isSensitiveKey(key) {
  if (typeof key !== "string") {
    const normalized = String(key).toLowerCase();
    return SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
  }
  const cacheable = key.length <= SENSITIVE_KEY_CACHE_KEY_MAX;
  if (cacheable) {
    const cached = sensitiveKeyCache.get(key);
    if (cached !== undefined) return cached;
  }
  const normalized = key.toLowerCase();
  const sensitive = SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
  if (!cacheable) return sensitive;
  if (sensitiveKeyCache.size >= SENSITIVE_KEY_CACHE_MAX) {
    sensitiveKeyCache.delete(sensitiveKeyCache.keys().next().value);
  }
  sensitiveKeyCache.set(key, sensitive);
  return sensitive;
}
`;

const PRE = `function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SENSITIVE_KEY_PARTS.some((needle) => normalized.includes(needle));
}
`;

export function reverseSensitiveKeyMemoRound(file, source) {
  if (file !== "lib/dockyard-domain/memory.js") return source;
  assert.equal(source.split(POST).length - 1, 1,
    `${file}: sensitive-key memo reversal anchor must occur exactly once`);
  return source.replace(POST, PRE);
}
