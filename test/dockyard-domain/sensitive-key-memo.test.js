// Differential proof for the bounded `isSensitiveKey()` memo in memory.js.
// The production function is extracted from the actual source (not re-typed
// here) and compared, field for field, against the pre-memo implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MEMORY = new URL('../../lib/dockyard-domain/memory.js', import.meta.url);
const source = fs.readFileSync(MEMORY, 'utf8');

// The memo block lives between these two anchors. Replacing or moving it must
// fail loudly rather than silently testing a stale copy.
const START = 'const SENSITIVE_KEY_PARTS = Object.freeze([';
const END = '\nfunction redact(';
const start = source.indexOf(START);
const end = source.indexOf(END, start);
assert.ok(start >= 0 && end > start, 'sensitive-key memo block anchors must exist and be unique');
assert.equal(source.indexOf(START, start + 1), -1, 'memo start anchor must be unique');
const block = source.slice(start, end);

function writeModule(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-sensitive-key-'));
  const file = path.join(dir, 'sensitive.mjs');
  fs.writeFileSync(file, `${text}\nexport { isSensitiveKey };\nexport const cacheSize = () => sensitiveKeyCache.size;\n`);
  return { dir, url: pathToFileURL(file).href };
}

// The pre-memo reference: compute every time, no cache. Verbatim from the
// release this change is measured against.
const PARTS = Object.freeze([
  'accesstoken', 'refreshtoken', 'token', 'secret', 'credential', 'credentialref', 'apikey', 'password',
]);
function reference(key) {
  const normalized = String(key).toLowerCase();
  return PARTS.some((needle) => normalized.includes(needle));
}

const { dir, url } = writeModule(block);
let current;
try {
  const loaded = await import(url);
  current = loaded.isSensitiveKey;
  const cacheSize = loaded.cacheSize;

  const fixed = [
    '', 'id', 'status', 'eventType', 'measurement', 'evidence', 'audit', 'at', 'producer',
    'experimentId', 'proposalId', 'target', 'capability', 'lineageId', 'latency', 'throughput',
    'testPassed', 'recordedAt', 'metrics', 'error', 'message', 'name', 'code', 'rootCause',
    'strategy', 'scope', 'beforeMetrics', 'afterMetrics', 'candidateMetrics', 'resourceMetrics',
    'accessToken', 'ACCESS_TOKEN', 'AccessToken', 'access-token', 'refreshtoken', 'RefreshToken',
    'apiKey', 'APIKEY', 'password', 'PASSWORD', 'secret', 'Secret', 'credential', 'Credentials',
    'credentialRef', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
    'prefixaccesstokensuffix', 'TOKEN', 'token', 'ToKeN', 'a token here', 'not-a-secret',
    'pässword', 'ПАРОЛЬ', '🔑secret', 'secret🔑', 'x'.repeat(500), 'token' + 'x'.repeat(500),
  ];
  for (const key of fixed) {
    assert.equal(current(key), reference(key), `fixed corpus key ${JSON.stringify(key).slice(0, 40)}`);
  }

  // Drive the cache past its bound with unique keys, then re-check the answers:
  // a stale-value or unbounded-cache bug changes a result here.
  for (let i = 0; i < 2000; i += 1) current(`unique-key-${i}-${'z'.repeat(i % 7)}`);
  for (const key of [...fixed, 'accessToken', 'id', '', 'secret']) {
    assert.equal(current(key), reference(key), `after eviction: ${JSON.stringify(key).slice(0, 40)}`);
  }

  // The entry bound alone is not a memory bound: the map holds the caller's
  // string, so a payload can offer a few hundred distinct multi-hundred-KiB
  // field names. Those must be classified without being retained.
  for (let i = 0; i < 512; i += 1) current(`long-key-${i}-token`);
  const retained = cacheSize();
  assert.ok(retained <= 512, `cache entry bound: ${retained}`);
  const longKeys = Array.from({ length: 64 }, (_, i) => `long-${i}-secret-${'q'.repeat(256 * 1024)}`);
  for (const key of longKeys) assert.equal(current(key), reference(key));
  assert.equal(cacheSize(), retained, 'keys longer than the bound must not be remembered');

  // Non-string inputs keep the compute-every-time path and the exact answer.
  const stateful = { toString() { return this.n++ % 2 ? 'accessToken' : 'id'; }, n: 0 };
  assert.equal(current(stateful), reference({ toString: stateful.toString, n: 0 }));
  assert.equal(current(undefined), reference(undefined));
  assert.equal(current(null), reference(null));
  assert.equal(current(42), reference(42));

  // Mutation check: the differential harness must reject a broken cache. A
  // variant that keys by only the first character collides distinct names and
  // returns stale answers, so comparing it to the reference must diverge.
  const poisoned = block.replace(
    'const cached = sensitiveKeyCache.get(key);',
    'const cached = sensitiveKeyCache.get(key.slice(0, 1));',
  ).replace(
    'sensitiveKeyCache.set(key, sensitive);',
    'sensitiveKeyCache.set(key.slice(0, 1), sensitive);',
  );
  assert.notEqual(poisoned, block, 'poison transform must apply');
  const broken = writeModule(poisoned);
  try {
    const brokenFn = (await import(broken.url)).isSensitiveKey;
    let diverged = false;
    for (const key of fixed) {
      if (brokenFn(key) !== reference(key)) { diverged = true; break; }
    }
    assert.equal(diverged, true, 'mutation must be caught by the differential');
  } finally {
    fs.rmSync(broken.dir, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
