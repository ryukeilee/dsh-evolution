// The capped-read acceptance candidate is not installed by the repository; the
// Test mounts it as the Trial's Host source. This pins the two things that made
// the first acceptance attempt fail: the post-execute hook sees the tool's raw
// rendered content (no `<path>/<content>` envelope), and the transform must
// stay bounded instead of appending an arbitrarily large tail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'acceptance', 'fixtures', 'complete-capped-read.host');
const body = fs.readFileSync(fixture, 'utf8');
const CAP_FOOTER = '(Output capped. Showing lines 1-620. Use offset=621 to continue.)';

function mount(files) {
  // The real Trial evaluates this body in a `node:vm` sandbox without Buffer
  // or process; TextEncoder is provided there (and is a Node global here).
  const plugin = new Function(body)();
  const listeners = [];
  const ctx = {
    on: (event, listener) => { if (event === 'tools/post-execute') listeners.push(listener); },
    fs: {
      resolve: async (file) => file,
      stat: async (file) => ({ type: 'file', size: Buffer.byteLength(files[file] ?? '') }),
      readText: async (file) => files[file],
    },
  };
  plugin.apply(ctx);
  assert.equal(listeners.length, 1);
  return listeners[0];
}

function readResult({ lines, totalLines, path: filePath, content }) {
  return {
    value: { path: filePath, offset: 1, lines, totalLines },
    content: [{ type: 'text', text: content }],
  };
}

function linesOf(text) {
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}

test('the raw renderer footer, without the host envelope, triggers the bounded tail', async () => {
  const rows = Array.from({ length: 620 }, (_, index) => 'route ' + index + ' checksum=' + 'x'.repeat(40));
  rows.push('sentinel: sentinel-a-abcdef');
  const file = '/isolated/a.txt';
  const text = rows.join('\n') + '\n';
  const listener = mount({ [file]: text });
  const first = rows.slice(0, 620).map((value, index) => ({ number: index + 1, text: value }));
  const decision = await listener(
    { name: 'read', arguments: { file_path: 'a.txt' }, agent: { session: { header: { cwd: '/isolated' } } }, signal: null },
    readResult({ lines: first, totalLines: rows.length, path: file, content: first.map((line) => line.text).join('\n') + '\n' + CAP_FOOTER }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(decision.kind, 'accept');
  assert.equal(decision.value.lines.length, rows.length);
  assert.equal(decision.value.lines.at(-1).text, rows.at(-1));

  // The same footer inside the host's `<content>` envelope must match too:
  // which shape the waterfall sees depends on the host path, and the policy
  // must not silently be a no-op on one of them.
  const enveloped = await listener(
    { name: 'read', arguments: { file_path: 'a.txt' }, agent: { session: { header: { cwd: '/isolated' } } }, signal: null },
    readResult({ lines: first, totalLines: rows.length, path: file, content: first.map((line) => line.text).join('\n') + '\n' + CAP_FOOTER + '\n</content>' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(enveloped.value.lines.length, rows.length);

  // The Trial's direct `ctx.tools.execute` path can hand the waterfall a result
  // without rendered content. An explicit limit that the window did not reach,
  // together with an unfinished file, is structural proof of the byte cap.
  const structural = await listener(
    { name: 'read', arguments: { file_path: 'a.txt', limit: 2000 }, agent: { session: { header: { cwd: '/isolated' } } }, signal: null },
    readResult({ lines: first, totalLines: rows.length, path: file, content: '' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(structural.value.lines.length, rows.length);

  // An explicit limit is a request boundary: a byte-capped window must not be
  // widened past it. 550 returned of a requested 600 ends at line 600, not EOF.
  const many = Array.from({ length: 700 }, (_, index) => 'row ' + index + ' ' + 'y'.repeat(50));
  const manyFile = '/isolated/many.txt';
  const manyListener = mount({ [manyFile]: many.join('\n') + '\n' });
  const manyFirst = many.slice(0, 550).map((value, index) => ({ number: index + 1, text: value }));
  const bounded = await manyListener(
    { name: 'read', arguments: { file_path: 'many.txt', limit: 600 }, agent: {}, signal: null },
    readResult({ lines: manyFirst, totalLines: many.length, path: manyFile, content: manyFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-550. Use offset=551 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(bounded.value.lines.length, 600);
  assert.equal(bounded.value.lines.at(-1).number, 600);
  const boundedStructural = await manyListener(
    { name: 'read', arguments: { file_path: 'many.txt', limit: 600 }, agent: {}, signal: null },
    readResult({ lines: manyFirst, totalLines: many.length, path: manyFile, content: '' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(boundedStructural.value.lines.length, 600);

  // Without rendered content AND without an explicit limit, a partial window
  // could be the deployment's own (smaller) default line cap: decline.
  const noLimitStructural = await listener(
    { name: 'read', arguments: {}, agent: {}, signal: null },
    readResult({ lines: manyFirst, totalLines: many.length, path: manyFile, content: '' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(noLimitStructural.value, undefined);
});

test('a non-capped read, an explicit window and an oversized tail are left untouched', async () => {
  const file = '/isolated/a.txt';
  const rows = Array.from({ length: 300 }, (_, index) => 'line ' + index);
  const listener = mount({ [file]: rows.join('\n') + '\n' });
  const first = rows.slice(0, 100).map((value, index) => ({ number: index + 1, text: value }));
  const untouched = await listener(
    { name: 'read', arguments: {}, agent: {}, signal: null },
    readResult({ lines: first, totalLines: rows.length, path: file, content: 'plain window\n(Showing lines 1-100 of 300. Use offset=101 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(untouched.value, undefined);

  // The renderer's cap footer but the missing tail is larger than the policy
  // budget: it must decline rather than read the rest of an arbitrary file.
  const huge = Array.from({ length: 5000 }, (_, index) => 'line ' + index);
  const hugeFile = '/isolated/huge.txt';
  const hugeListener = mount({ [hugeFile]: huge.join('\n') + '\n' });
  const hugeFirst = huge.slice(0, 100).map((value, index) => ({ number: index + 1, text: value }));
  const declined = await hugeListener(
    { name: 'read', arguments: {}, agent: {}, signal: null },
    readResult({ lines: hugeFirst, totalLines: huge.length, path: hugeFile, content: 'window\n(Output capped. Showing lines 1-100. Use offset=101 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(declined.value, undefined);
});

test('the candidate declines a non-read call and never throws through the hook', async () => {
  const listener = mount({});
  const decision = await listener(
    { name: 'bash', arguments: {}, agent: {}, signal: null },
    { value: {}, content: [] },
    async () => ({ kind: 'accept' }),
  );
  assert.equal(decision.value, undefined);
  const failed = await listener(
    { name: 'read', arguments: {}, agent: {}, signal: null },
    readResult({ lines: [], totalLines: 10, path: '/missing.txt', content: 'x\n(Output capped. Showing lines 1-1. Use offset=2 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(failed.value, undefined);
});
