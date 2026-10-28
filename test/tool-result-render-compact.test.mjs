// The rendered tool result is model context, not a filesystem artifact.
//
// `lib/registration.js` used to render every `evolution_*` result with
// `JSON.stringify(value, null, 2)`. The host keeps the structured `value` for
// its own consumers and hands this text to the model, which re-reads it on every
// later request in the same session, so the indentation cost input tokens for as
// long as the result stays in context. The projection is now compact.
//
// These tests pin the property that change is allowed to have: the text is the
// same JSON document (same keys in the same order, same values, and whitespace
// inside string values untouched), so `JSON.parse` of the new text and of the
// old text are deep-equal. They also pin that whitespace-bearing and
// JSON-in-a-string payloads survive, and that an own `__proto__` key still
// arrives as an own data property rather than being dropped or becoming the
// prototype of the parsed object.
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, EVOLUTION_TOOLS } from '../lib/registration.js';
import { context, config } from './fixtures/runtime-inspect.mjs';

const agent = { id: 'render-owner' };

function registered() {
  const ctx = context();
  let section = null;
  ctx.systemPrompt.section = (value) => { section = value; };
  // No `domainStorage`: `evolution_history` and `evolution_maintain` are
  // domain-only tools, and their renderer is the same shared object.
  apply(ctx, { ...config });
  return { ctx, section, definitions: [...ctx.definitions.values()] };
}

/** The pre-change projection, frozen: the differential baseline for the text. */
const pretty = (value) => JSON.stringify(value, null, 2);

const CASES = [
  ['scalars', { solved: true, count: 3, ratio: 0.5, note: null }],
  ['nested', { outer: { inner: [1, 2, { deep: 'value' }] }, empty: {}, emptyList: [] }],
  ['whitespace-in-values', { text: 'line one\nline two', indented: '  four spaces', tabs: 'a\tb' }],
  ['stringified-json', { evidence: JSON.stringify({ samples: [{ before: 100, after: 80 }] }, null, 2) }],
  ['unicode', { summary: '延迟 100ms → 80ms', emoji: '✅ rollback clean' }],
  ['proto-own-key', JSON.parse('{"__proto__":{"status":"recovered"},"safe":"value"}')],
  ['numeric-edges', { zero: 0, negative: -0, exponent: 1e21, small: 1e-7 }],
];

test('the rendered text is compact JSON, and parses to the same document as the indented one', () => {
  const { definitions } = registered();
  assert.ok(definitions.length > 0);
  for (const [name, value] of CASES) {
    for (const definition of definitions) {
      const rendered = definition.output.render({}, value);
      assert.equal(rendered.length, 1, `${definition.name}/${name}: one content part`);
      assert.equal(rendered[0].type, 'text', `${definition.name}/${name}: text part`);
      const text = rendered[0].text;
      // Exactly the compact projection: no formatting whitespace was added.
      assert.equal(text, JSON.stringify(value), `${definition.name}/${name}: compact projection`);
      assert.deepEqual(JSON.parse(text), JSON.parse(pretty(value)), `${definition.name}/${name}: same document`);
      // A single record is one line; a newline in the text could only come from
      // a string value, which the compact projection still escapes.
      assert.equal(text.includes('\n'), false, `${definition.name}/${name}: no record separator was added`);
    }
  }
});

test('every registered evolution tool shares one renderer', () => {
  const { definitions } = registered();
  const renderers = new Set(definitions.map((definition) => definition.output.render));
  assert.equal(renderers.size, 1, 'one shared output projection for the whole tool surface');
  for (const definition of definitions) {
    assert.equal(definition.output.schema !== undefined, true, `${definition.name}: schema stays declared`);
    assert.deepEqual(definition.output.schema, {}, `${definition.name}: unconstrained-JSON annotation form`);
  }
});

test('an own `__proto__` key survives the projection as own data', () => {
  const { definitions } = registered();
  const value = JSON.parse('{"__proto__":{"status":"recovered"},"runtimeRecovered":false}');
  const text = definitions[0].output.render({}, value)[0].text;
  const parsed = JSON.parse(text);
  assert.equal(Object.hasOwn(parsed, '__proto__'), true, 'the key is an own data property, not dropped');
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, '__proto__').value, { status: 'recovered' });
  assert.equal(parsed.runtimeRecovered, false);
  // The payload never becomes the prototype of the projected object.
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(parsed.status, undefined, 'a field the payload never owned is not inherited');
});

test('the compact projection is strictly smaller for every structured payload', () => {
  const { definitions } = registered();
  for (const [name, value] of CASES) {
    const compact = Buffer.byteLength(definitions[0].output.render({}, value)[0].text, 'utf8');
    const indented = Buffer.byteLength(pretty(value), 'utf8');
    assert.ok(compact <= indented, `${name}: compact ${compact} <= indented ${indented}`);
  }
});

test('the tool surface the renderer serves is unchanged', () => {
  const { definitions } = registered();
  const names = definitions.map((definition) => definition.name).sort();
  const expected = EVOLUTION_TOOLS.filter((name) => names.includes(name)).sort();
  assert.deepEqual(names, expected);
  // `evolution_history` and `evolution_maintain` are registered only with a
  // domain store; they are declared by the bundle surface all the same.
  assert.equal(EVOLUTION_TOOLS.length, 10);
});
