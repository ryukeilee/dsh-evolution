// Minimal test harness for dsh-evolution-orchestrator tests.
// Exits non-zero on the first failing assertion, prints PASS/FAIL per test.
// Tests that create scratch dirs MUST register them via registerCleanup()
// so summary() removes them (no leftover temp dirs between runs).

import fs from 'node:fs';

let passed = 0;
let failed = 0;
const failures = [];
const cleanups = [];

export function registerCleanup(pathOrFn) {
  cleanups.push(pathOrFn);
}

export async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    failed += 1;
    failures.push({ name, error: error.message || String(error) });
    console.log('FAIL', name, '::', error.message || error);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function summary() {
  for (const item of cleanups) {
    try {
      if (typeof item === 'string') fs.rmSync(item, { recursive: true, force: true });
      else if (typeof item === 'function') item();
    } catch (error) {
      console.log('CLEANUP-WARN', error.message || error);
    }
  }
  cleanups.length = 0;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(' -', f.name, '::', f.error);
    process.exit(1);
  }
}