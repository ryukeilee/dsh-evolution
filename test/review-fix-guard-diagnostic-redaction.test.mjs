// The guard's non-blocking composition diagnostic crosses the credential
// boundary: a throwing getter in exec.arguments and a secret-bearing error
// message must never reach ctx.emit or the host logger raw.
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/guard.js';

function ctx() {
  const emitted = [];
  return {
    emitted,
    on(name, listener) { if (name === 'tools/post-execute') this.listener = listener; },
    emit(...args) { emitted.push(args); },
    logger: { warn(...args) { emitted.push(['warn', ...args]); } },
    storageDomain: {},
    inject() {},
  };
}

test('a secret-bearing error in a non-blocking diagnostic is redacted', () => {
  const c = ctx();
  apply(c, {});
  c.listener({ arguments: { file_path: '/repo/agent.cordis.yml' } }, {}, () => {});
  // Force the diagnostic's own catch: a throwing getter while reading arguments.
  const hostile = { get file_path() { throw new Error('SECRET_token=abc123 leaked'); } };
  c.listener({ arguments: hostile }, {}, () => {});
  const serialized = JSON.stringify(c.emitted);
  assert.equal(serialized.includes('abc123'), false);
  assert.ok(c.emitted.some((entry) => entry[0] === 'composition/diagnostic' && entry[1].filePath === null));
  assert.ok(c.emitted.some((entry) => typeof entry[1]?.error === 'string' && entry[1].error.includes('[redacted]')));
});

test('a file path carrying a credential is redacted in the error branch', () => {
  const c = ctx();
  apply(c, {});
  const hostilePath = '/tmp/agent-presets/SECRET_token=abc123/agent.cordis.yml';
  const args = {
    file_path: hostilePath,
    get content() { throw new Error('diagnostic input failed'); },
  };
  c.listener({ arguments: args }, {}, () => {});
  const serialized = JSON.stringify(c.emitted);
  assert.equal(serialized.includes('abc123'), false);
  assert.ok(serialized.includes('[redacted]'));
});

test('a throwing getter cannot escape the diagnostic listener', () => {
  const c = ctx();
  apply(c, {});
  const hostile = { get file_path() { throw new Error('boom'); } };
  assert.doesNotThrow(() => c.listener({ arguments: hostile }, {}, () => {}));
});
