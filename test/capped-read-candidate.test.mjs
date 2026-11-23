// The capped-read acceptance candidate is not installed by the repository; the
// Test mounts it as the Trial's Host source. This pins the two things that made
// the first acceptance attempt fail: the post-execute hook sees the tool's raw
// rendered content (no `<path>/<content>` envelope), and the transform must
// stay bounded instead of appending an arbitrarily large tail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'acceptance', 'fixtures', 'complete-capped-read.host');
const body = fs.readFileSync(fixture, 'utf8');
const CAP_FOOTER = '(Output capped. Showing lines 1-620. Use offset=621 to continue.)';

function mount(files, { versions = null, preNext = null } = {}) {
  // The real Trial runs this body in a `node:vm` sandbox that provides neither
  // Buffer nor process (only TextEncoder/TextDecoder/btoa/atob). A plain
  // `new Function` would still expose Node's globals and let a Buffer
  // dependency pass here while failing in the Trial, so mount it the same way.
  const sandbox = { TextEncoder, TextDecoder, btoa, atob };
  assert.equal(vm.runInNewContext('typeof Buffer', sandbox), 'undefined');
  assert.equal(vm.runInNewContext('typeof process', sandbox), 'undefined');
  const plugin = vm.runInNewContext(`(function(){${body}})()`, sandbox, { filename: 'complete-capped-read.host' });
  const preListeners = [];
  const postListeners = [];
  let statCall = 0;
  const ctx = {
    on: (event, listener) => {
      if (event === 'tools/pre-execute') preListeners.push(listener);
      if (event === 'tools/post-execute') postListeners.push(listener);
    },
    fs: {
      resolve: async (file, options = {}) => {
        if (path.isAbsolute(file)) return file;
        if (typeof options.cwd === 'string' && path.isAbsolute(options.cwd)) return path.resolve(options.cwd, file);
        const match = Object.keys(files).find((key) => key === file || key.endsWith('/' + file));
        return match ?? file;
      },
      stat: async (file) => {
        const sequence = versions?.[file];
        const version = Array.isArray(sequence) ? (sequence[statCall] ?? sequence.at(-1)) : (sequence ?? 'v1');
        statCall += 1;
        return { type: 'file', size: Buffer.byteLength(files[file] ?? ''), version };
      },
      readText: async (file) => files[file],
    },
  };
  plugin.apply(ctx);
  assert.equal(preListeners.length, 1);
  assert.equal(postListeners.length, 1);
  return async (exec, result, next) => {
    const withId = typeof exec?.callId === 'string' ? exec : { ...exec, callId: 'test-call' };
    await preListeners[0](withId, preNext ?? (async () => ({ kind: 'accept' })));
    return postListeners[0](withId, result, next);
  };
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
    { name: 'read', arguments: { file_path: 'a.txt', limit: 2000 }, agent: { session: { header: { cwd: '/isolated' } } }, signal: null },
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
    { name: 'read', arguments: { file_path: 'a.txt', limit: 2000 }, agent: { session: { header: { cwd: '/isolated' } } }, signal: null },
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

  // Without an explicit limit the footer does not reveal the deployment's line
  // window, so the policy must keep the original result rather than widening it
  // to EOF or to a guessed default.
  const deep = Array.from({ length: 2090 }, (_, index) => 'row ' + index + ' ' + 'z'.repeat(40));
  const deepFile = '/isolated/deep.txt';
  const deepListener = mount({ [deepFile]: deep.join('\n') + '\n' });
  const deepFirst = deep.slice(0, 1896).map((value, index) => ({ number: index + 1, text: value }));
  const noProvableWindow = await deepListener(
    { name: 'read', arguments: { file_path: 'deep.txt' }, agent: {}, signal: null },
    readResult({ lines: deepFirst, totalLines: deep.length, path: deepFile, content: deepFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-1896. Use offset=1897 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(noProvableWindow.value, undefined);

  // A caller-declared window is provable even when the deployment's default is
  // smaller: 1,896 returned of a requested 2,000 stops at 2,000, not EOF.
  const declaredWindow = await deepListener(
    { name: 'read', arguments: { file_path: 'deep.txt', limit: 2000 }, agent: {}, signal: null },
    readResult({ lines: deepFirst, totalLines: deep.length, path: deepFile, content: deepFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-1896. Use offset=1897 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(declaredWindow.value.lines.length, 2000);
  assert.equal(declaredWindow.value.lines.at(-1).number, 2000);

  // A tail line longer than the renderer's per-line cap would be delivered
  // without that cap, so the policy declines instead of appending it.
  const longTail = [...deep.slice(0, 620), 'x'.repeat(3000)];
  const longFile = '/isolated/long-tail.txt';
  const longListener = mount({ [longFile]: longTail.join('\n') + '\n' });
  const longFirst = longTail.slice(0, 620).map((value, index) => ({ number: index + 1, text: value }));
  const longDeclined = await longListener(
    { name: 'read', arguments: { file_path: 'long-tail.txt', limit: 2000 }, agent: {}, signal: null },
    readResult({ lines: longFirst, totalLines: longTail.length, path: longFile, content: longFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-620. Use offset=621 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(longDeclined.value, undefined);

  // A file replaced between the host's window and the policy's re-read must not
  // be spliced: the new tail cannot be appended to the old head.
  const snapshotRows = [...deep.slice(0, 620), 'sentinel-a'];
  const replacedRows = [...snapshotRows];
  replacedRows[0] = 'changed after the host read';
  const snapshotFile = '/isolated/snapshot.txt';
  const snapshotListener = mount({ [snapshotFile]: replacedRows.join('\n') + '\n' });
  const snapshotFirst = snapshotRows.slice(0, 620).map((value, index) => ({ number: index + 1, text: value }));
  const replaced = await snapshotListener(
    { name: 'read', arguments: { file_path: 'snapshot.txt', limit: 2000 }, agent: {}, signal: null },
    readResult({ lines: snapshotFirst, totalLines: snapshotRows.length, path: snapshotFile, content: snapshotFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-620. Use offset=621 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(replaced.value, undefined);

  // Same head and total, only the tail replaced: the freshness token is the
  // only proof, and it must decline when it changed.
  const tailFile = '/isolated/tail-only.txt';
  const tailOld = [...deep.slice(0, 620), 'sentinel-old'];
  const tailNew = [...deep.slice(0, 620), 'sentinel-new'];
  const tailListener = mount({ [tailFile]: tailNew.join('\n') + '\n' }, { versions: { [tailFile]: ['v1', 'v2'] } });
  const tailFirst = tailOld.slice(0, 620).map((value, index) => ({ number: index + 1, text: value }));
  const tailReplaced = await tailListener(
    { name: 'read', arguments: { file_path: 'tail-only.txt', limit: 2000 }, agent: {}, signal: null },
    readResult({ lines: tailFirst, totalLines: tailOld.length, path: tailFile, content: tailFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-620. Use offset=621 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(tailReplaced.value, undefined, 'a changed freshness token must keep the original result');

  // A downstream post-execute rewrite is not a byte-capped original result;
  // the policy must not append the lines that rewrite removed.
  const downstreamRows = ['one', 'two', 'three', 'four', 'five'];
  const downstreamFile = '/isolated/downstream.txt';
  const downstream = mount({ [downstreamFile]: downstreamRows.join('\n') + '\n' });
  const originalLines = downstreamRows.slice(0, 3).map((value, index) => ({ number: index + 1, text: value }));
  const downstreamDecision = await downstream(
    { name: 'read', arguments: { file_path: 'downstream.txt', limit: 5 }, agent: {}, signal: null },
    readResult({ lines: originalLines, totalLines: 5, path: downstreamFile, content: '' }),
    async () => ({ kind: 'accept', value: { path: downstreamFile, offset: 1, lines: [originalLines[0]], totalLines: 5 } }),
  );
  assert.equal(downstreamDecision.value.lines.length, 1, 'a downstream rewrite keeps its own window');

  const contentDecision = await downstream(
    { name: 'read', arguments: { file_path: 'downstream.txt', limit: 5 }, agent: {}, signal: null },
    readResult({ lines: originalLines, totalLines: 5, path: downstreamFile, content: '' }),
    async () => ({ kind: 'accept', value: { path: downstreamFile, offset: 1, lines: originalLines, totalLines: 5 }, content: [{ type: 'text', text: 'downstream content' }] }),
  );
  assert.equal(contentDecision.content[0].text, 'downstream content', 'a downstream content rewrite is preserved');
  assert.equal(contentDecision.value.lines.length, 3, 'the candidate does not re-render over rewritten content');

  const inPlace = readResult({ lines: originalLines, totalLines: 5, path: downstreamFile, content: 'one\ntwo\nthree\n(Output capped. Showing lines 1-3. Use offset=4 to continue.)' });
  const inPlaceDecision = await downstream(
    { name: 'read', arguments: { file_path: 'downstream.txt', limit: 5 }, agent: {}, signal: null },
    inPlace,
    async () => {
      inPlace.content = [];
      return { kind: 'accept', value: inPlace.value };
    },
  );
  assert.equal(inPlaceDecision.value.lines.length, 3, 'an in-place content clear is not a structural cap signal');

  const inPlaceWindow = readResult({ lines: originalLines, totalLines: 5, path: downstreamFile, content: 'one\ntwo\nthree\n(Output capped. Showing lines 1-3. Use offset=4 to continue.)' });
  const inPlaceWindowDecision = await downstream(
    { name: 'read', arguments: { file_path: 'downstream.txt', limit: 5 }, agent: {}, signal: null },
    inPlaceWindow,
    async () => {
      inPlaceWindow.value.lines = [originalLines[0]];
      return { kind: 'accept' };
    },
  );
  assert.equal(inPlaceWindowDecision.value, undefined, 'an implicit shortened window is preserved');
  assert.equal(inPlaceWindow.value.lines.length, 1);

  const noOriginal = await downstream(
    { name: 'read', arguments: { file_path: 'downstream.txt', limit: 5 }, agent: {}, signal: null },
    { content: [{ type: 'text', text: 'one\ntwo\nthree\n(Output capped. Showing lines 1-3. Use offset=4 to continue.)' }] },
    async () => ({ kind: 'accept', value: { path: downstreamFile, offset: 1, lines: [originalLines[0]], totalLines: 5 } }),
  );
  assert.equal(noOriginal.value.lines.length, 1, 'a downstream value without an original window is never widened');

  // A downstream mutation of the requested limit must not widen the append.
  const limitRows = Array.from({ length: 30 }, (_, index) => 'line ' + index);
  const limitFile = '/isolated/limit.txt';
  const limitListener = mount({ [limitFile]: limitRows.join('\n') + '\n' });
  const limitFirst = limitRows.slice(0, 20).map((value, index) => ({ number: index + 1, text: value }));
  const limitExec = { name: 'read', arguments: { file_path: 'limit.txt', limit: 26 }, agent: {}, signal: null };
  const limitDecision = await limitListener(
    limitExec,
    readResult({ lines: limitFirst, totalLines: limitRows.length, path: limitFile, content: limitFirst.map((line) => line.text).join('\n') + '\n(Output capped. Showing lines 1-20. Use offset=21 to continue.)' }),
    async () => { limitExec.arguments.limit = 30; return { kind: 'accept' }; },
  );
  assert.equal(limitDecision.value.lines.length, 26, 'the append uses the limit captured before downstream hooks');

  const limitRows2 = ['one', 'two', 'three', 'four', 'five'];
  const limitFile2 = '/isolated/limit-pre.txt';
  const limitExec2 = { name: 'read', arguments: { file_path: 'limit-pre.txt', limit: 2 }, agent: {}, signal: null };
  const limitListener2 = mount({ [limitFile2]: limitRows2.join('\n') + '\n' }, {
    preNext: async () => { limitExec2.arguments.limit = 3; return { kind: 'accept' }; },
  });
  const limitFirst2 = [{ number: 1, text: 'one' }];
  const limitDecision2 = await limitListener2(
    limitExec2,
    readResult({ lines: limitFirst2, totalLines: 5, path: limitFile2, content: 'one\n(Output capped. Showing lines 1-1. Use offset=2 to continue.)' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(limitDecision2.value.lines.length, 2, 'a pre-execute limit mutation cannot widen the caller request');

  const offsetExec = { name: 'read', arguments: { file_path: 'offset-pre.txt', offset: 1, limit: 2 }, agent: {}, signal: null };
  const offsetFile = '/isolated/offset-pre.txt';
  const offsetRows = ['one', 'two', 'three', 'four', 'five'];
  const offsetListener = mount({ [offsetFile]: offsetRows.join('\n') + '\n' }, {
    preNext: async () => { offsetExec.arguments.offset = 3; return { kind: 'accept' }; },
  });
  const offsetFirst = [{ number: 3, text: 'three' }];
  const offsetDecision = await offsetListener(
    offsetExec,
    { value: { path: offsetFile, offset: 3, lines: offsetFirst, totalLines: 5 }, content: [{ type: 'text', text: 'three\n(Output capped. Showing lines 1-3. Use offset=4 to continue.)' }] },
    async () => ({ kind: 'accept' }),
  );
  assert.equal(offsetDecision.value, undefined, 'a pre-execute offset mutation cannot be appended');

  const shrinkExec = { name: 'read', arguments: { file_path: 'shrink.txt', limit: 5 }, agent: {}, signal: null };
  const shrinkFile = '/isolated/shrink.txt';
  const shrinkListener = mount({ [shrinkFile]: offsetRows.join('\n') + '\n' }, {
    preNext: async () => { shrinkExec.arguments.limit = 3; return { kind: 'accept' }; },
  });
  const shrinkFirst = offsetRows.slice(0, 3).map((value, index) => ({ number: index + 1, text: value }));
  const shrinkDecision = await shrinkListener(
    shrinkExec,
    readResult({ lines: shrinkFirst, totalLines: 5, path: shrinkFile, content: '' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(shrinkDecision.value, undefined, 'a downstream-shrunk effective window is not a byte cap');

  const deleteExec = { name: 'read', arguments: { file_path: 'delete.txt', limit: 5 }, agent: {}, signal: null };
  const deleteFile = '/isolated/delete.txt';
  const deleteListener = mount({ [deleteFile]: offsetRows.join('\n') + '\n' }, {
    preNext: async () => { delete deleteExec.arguments.limit; return { kind: 'accept' }; },
  });
  const deleteFirst = offsetRows.slice(0, 3).map((value, index) => ({ number: index + 1, text: value }));
  const deleteDecision = await deleteListener(
    deleteExec,
    readResult({ lines: deleteFirst, totalLines: 5, path: deleteFile, content: '' }),
    async () => ({ kind: 'accept' }),
  );
  assert.equal(deleteDecision.value, undefined, 'a missing effective limit cannot be inferred as a byte cap');

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
