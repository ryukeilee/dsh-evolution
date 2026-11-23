// The shared PTC refusal and envelope bridge.
//
// The predicate must accept only the executor's own direct-call refusal, bound
// to the exact tool name and (when present) to its structured ToolNotFoundError
// classification. An ordinary tool or policy error that quotes the sentence
// keeps its original path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PTC_WRAPPED_VALUE,
  ptcDirectCallRefusal,
  ptcKernelCallProgram,
  ptcWrappedEnvelope,
} from '../lib/ptc-transport.js';

const refusal = (toolName, { info = { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' }, prefix = '' } = {}) => ({
  isError: true,
  error: {
    message: `${prefix}unknown tool "${toolName}": only \`run_code\` is callable directly — call \`${toolName}\` from inside a \`run_code\` program instead`,
    ...(info === undefined ? {} : { info }),
  },
});

test('the official PTC direct-call refusal is recognized for the exact tool', () => {
  assert.notEqual(ptcDirectCallRefusal(refusal('read'), 'read'), null);
  // A host that prefixes the pipeline context still carries the same shape.
  assert.notEqual(ptcDirectCallRefusal(refusal('read', { prefix: 'runtime refused: ' }), 'read'), null);
  // Older hosts may project only the message; the name-bound shape still holds.
  assert.notEqual(ptcDirectCallRefusal(refusal('read', { info: undefined }), 'read'), null);
});

test('an ordinary error quoting the refusal phrase is not recognized', () => {
  assert.equal(ptcDirectCallRefusal({ isError: true, error: { message: 'policy: only `run_code` is callable directly' } }, 'read'), null);
  assert.equal(ptcDirectCallRefusal({
    isError: true,
    error: { message: 'unknown tool "other": only `run_code` is callable directly — call `other` from inside a `run_code` program instead' },
  }, 'read'), null);
  assert.equal(ptcDirectCallRefusal(refusal('read', { info: { name: 'Error', code: 'E_TOOL' } }), 'read'), null);
  assert.equal(ptcDirectCallRefusal(refusal('read', { info: { name: 'ToolNotFoundError', code: 'E_OTHER' } }), 'read'), null);
  assert.equal(ptcDirectCallRefusal({ isError: false, error: { message: 'unknown tool "read": only `run_code` is callable directly' } }, 'read'), null);
  assert.equal(ptcDirectCallRefusal(refusal('read'), '../escape'), null);
});

test('the kernel wrapper parses arguments as JSON, preserving own __proto__ keys', () => {
  const args = JSON.parse('{"label":"x","__proto__":{"polluted":true}}');
  const program = ptcKernelCallProgram('evolution_propose', args);
  const parsed = /const args = JSON\.parse\(("(?:[^"\\]|\\.)*")\);/.exec(program);
  assert.ok(parsed, 'the program parses its JSON text before calling the tool');
  const delivered = JSON.parse(JSON.parse(parsed[1]));
  assert.equal(Object.hasOwn(delivered, '__proto__'), true, 'the own data key survives');
  assert.deepEqual(Object.keys(delivered), ['label', '__proto__']);
  assert.equal(delivered.polluted, undefined, 'the prototype was not polluted');
  assert.equal(program.includes('await tools["evolution_propose"](args)'), true);
});

test('the wrapper envelope is unwrapped only through its sentinel', () => {
  assert.deepEqual(ptcWrappedEnvelope({ logs: [], result: { [PTC_WRAPPED_VALUE]: { ok: true } } }), { [PTC_WRAPPED_VALUE]: { ok: true } });
  assert.equal(ptcWrappedEnvelope({ logs: [], result: { unrelated: true } }), null);
  assert.equal(ptcWrappedEnvelope({ logs: [] }), null);
  assert.equal(ptcWrappedEnvelope({ logs: [], result: { logs: [] } }), null);
  // A tool value containing the envelope keys is not itself the envelope.
  assert.deepEqual(
    ptcWrappedEnvelope({ logs: [], result: { [PTC_WRAPPED_VALUE]: { result: { logs: [] } } } }),
    { [PTC_WRAPPED_VALUE]: { result: { logs: [] } } },
  );
});
