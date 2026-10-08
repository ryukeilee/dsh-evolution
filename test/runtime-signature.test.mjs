import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSignature, signatureEqual } from '../lib/orchestrator.js';
import { legacyRuntimeSignature, legacySignatureEqual, signatureFixture } from './fixtures/runtime-signature.mjs';

test('signature bytes and recovery decisions match the original across sizes and mutations', () => {
  for (const count of [0, 1, 2, 20, 100]) {
    const runtime = signatureFixture(count);
    assert.deepEqual(runtimeSignature(runtime), legacyRuntimeSignature(runtime));
    assert.equal(JSON.stringify(runtimeSignature(runtime)), JSON.stringify(legacyRuntimeSignature(runtime)));
    for (const mutate of [
      value => value.components.reverse(),
      value => { if (value.components.length) value.components[0].state = 'changed'; },
      value => { value.recoveryProof.unknown = ['stable-owner']; },
      value => { value.recoveryProof.unknown = ['module-registry']; },
      value => { delete value.recoveryProof; },
      value => { if (value.dynamicPlugins.length) value.dynamicPlugins[0].currentPackageId = 999; },
    ]) {
      const changed = structuredClone(runtime); mutate(changed);
      assert.equal(signatureEqual(runtime, changed), legacySignatureEqual(runtime, changed));
    }
    const before = structuredClone(runtime);
    runtimeSignature(runtime);
    assert.deepEqual(runtime, before);
  }
});

test('exotic sort values retain serialization calls, errors, and stable ties', () => {
  for (const kind of ['getter', 'toJSON', 'proxy', 'cycle', 'bigint', 'date', 'undefined', 'ties']) {
    const run = signature => {
      let calls = 0;
      let value;
      if (kind === 'getter') value = { get value() { calls++; return calls; } };
      if (kind === 'toJSON') value = { toJSON() { calls++; return calls; } };
      if (kind === 'proxy') value = new Proxy({ value: 1 }, { get(target, key) { calls++; return target[key]; } });
      if (kind === 'cycle') { value = {}; value.self = value; }
      if (kind === 'bigint') value = 1n;
      if (kind === 'date') value = new Date(0);
      if (kind === 'ties') value = NaN;
      const runtime = { services: Array(40).fill(value).map((name, i) => ({ name, owner: { name: i } })) };
      try { return { bytes: JSON.stringify(signature(runtime)), calls }; }
      catch (error) { return { error: error.name, message: error.message, calls }; }
    };
    assert.deepEqual(run(runtimeSignature), run(legacyRuntimeSignature), kind);
  }
});

test('nested event and package sort keys retain complete signatures', () => {
  const runtime = signatureFixture(100);
  runtime.events = Array.from({ length: 40 }, (_, i) => ({ name: `event-${40 - i}`,
    listeners: runtime.services.map(row => ({ callback: row.name, owner: row.owner })) }));
  runtime.dynamicPlugins = Array.from({ length: 40 }, (_, i) => ({ pluginId: `plugin-${i}`,
    packages: runtime.services.map((row, j) => ({ name: row.name, purpose: row.state, packageId: j })),
    currentPackageId: i, nextPackageId: i + 1 }));
  assert.deepEqual(runtimeSignature(runtime), legacyRuntimeSignature(runtime));
});

test('sort serialization is linear and keys are rebuilt after live mutations', () => {
  const runtime = signatureFixture(100);
  const original = JSON.stringify;
  const calls = signature => {
    let count = 0;
    JSON.stringify = (...args) => { count++; return original(...args); };
    try { signature(runtime); return count; }
    finally { JSON.stringify = original; }
  };
  assert.ok(calls(runtimeSignature) < calls(legacyRuntimeSignature) / 2);
  const before = runtimeSignature(runtime);
  runtime.components[0].name = 'changed';
  assert.notDeepEqual(runtimeSignature(runtime), before);
  assert.deepEqual(runtimeSignature(runtime), legacyRuntimeSignature(runtime));
});
