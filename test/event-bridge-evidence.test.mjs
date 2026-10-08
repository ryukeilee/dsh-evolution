import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { readEventBridgeEvidence as candidate, signEventBridgeEnvelope } from '../lib/orchestrator.js';
import { readEventBridgeEvidence as baseline } from './fixtures/event-bridge-evidence.mjs';

const key = 'isolated-event-bridge-differential-key';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-evidence-diff-'));
const file = path.join(home, 'events.jsonl');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const signed = (sequence, event, writer = 'dsh-evolution-orchestrator') => signEventBridgeEnvelope(event, { key, sequence, writer });
const measurement = (value, experimentId = 'target') => ({ experimentId, eventType: 'measurement-completed', measurement: { value }, audit: { at: `at-${value}` } });
const outcome = async (run, input = file, options = { key }) => {
  try { return { result: await run(input, 'target', options) }; }
  catch (error) { return { error: { name: error.name, code: error.code, message: error.message, errors: error.errors?.map(entry => ({ name: entry.name, code: entry.code, message: entry.message })) } }; }
};
const equal = async (input = file, options = { key }) => assert.deepEqual(await outcome(candidate, input, options), await outcome(baseline, input, options));

test('recovery preserves authentication, per-writer ordering, duplicates and complete evidence', async () => {
  const tampered = signed(1000, measurement('tampered'));
  tampered.event.measurement.value = 'forged';
  const events = [
    signed(1, measurement(1)), signed(1, measurement('duplicate')),
    signed(9, measurement('other-experiment', 'other')),
    signed(8, measurement('old-target')),
    tampered, signed(10, measurement(10)),
    signed(100, measurement('untrusted'), 'untrusted'),
    signed(1, measurement('second-writer'), 'writer:2'),
    signed(2, { experimentId: 'target', eventType: 'promotion-succeeded', evidence: { runtimeRecovered: true, eligible: true }, promotion: { pluginName: 'retained', promotionTimestamp: 'promotion-at' }, measurement: { ignored: true } }, 'writer:2'),
    signed(3, { experimentId: 'target', eventType: 'canary-passed', canary: { observations: [{ factual: true }], startupVerified: true } }, 'writer:2'),
    signed(11, { experimentId: 'target', eventType: 'unrecognized', audit: { at: 'last-at' } }),
  ];
  fs.writeFileSync(file, '\n \r\n{broken\nnull\n' + events.map(JSON.stringify).join('\r\n') + '\n{"partial":');
  const options = { key, trustedWriters: ['dsh-evolution-orchestrator', 'writer:2'] };
  await equal(file, options);
  const result = await candidate(file, 'target', options);
  assert.equal(result.latestObservation.value, 'second-writer');
  assert.equal(result.capturedAt, 'last-at');
  assert.equal(result.runtimeRecovered, true);
  assert.deepEqual(result.observations, [{ value: 'second-writer' }, { factual: true }]);
  for (const options of [{ key: 'short' }, { key: 'wrong-key-long-enough' }, { key, trustedWriters: [] }, { key, trustedWriters: 'writer' }, { key, trustedWriters: 7 }]) await equal(file, options);
});

test('chunk boundaries, huge lines, unicode and final partial lines match readFile decoding', async () => {
  for (const prefix of [0, 1024 * 1024 - 1, 1024 * 1024 - 153]) {
    const large = signed(1, measurement('中文😀'.repeat(300000)));
    const tail = signed(2, measurement('last-中文😀'));
    fs.writeFileSync(file, ' '.repeat(prefix) + JSON.stringify(large) + '\n\n' + JSON.stringify(tail));
    await equal();
    assert.equal((await candidate(file, 'target', { key })).latestObservation.value, 'last-中文😀');
  }
  for (const content of ['', '\n', ' \r\n\n', '{}', '{torn', '\uFEFF{}\n', 'null\nfalse\n[]\n', JSON.stringify(signed(1, measurement(1))) + '\n{torn']) {
    fs.writeFileSync(file, content);
    await equal();
  }
  const line = Buffer.from(JSON.stringify(signed(1, measurement('unicode'))));
  const invalidUtf8 = Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 32), Buffer.from([0xe2]), Buffer.from('\n'), line, Buffer.from('\n'), Buffer.from([0xf0, 0x9f])]);
  fs.writeFileSync(file, invalidUtf8);
  await equal();
});

test('file inputs, read errors, invalid options and subsequent rewrites retain behavior', async () => {
  fs.writeFileSync(file, JSON.stringify(signed(1, measurement(1))));
  await equal(Buffer.from(file));
  await equal(pathToFileURL(file));
  await equal(path.join(home, 'absent'), { key, trustedWriters: 7 });
  await equal(home, { key: 'short', trustedWriters: 7 });
  await equal({ invalid: true });
  for (const run of [candidate, baseline]) {
    const handle = await fsp.open(file, 'r');
    try {
      assert.equal((await run(handle, 'target', { key })).latestObservation.value, 1);
      assert.ok((await handle.stat()).isFile(), 'caller-owned FileHandle remains open');
    } finally { await handle.close(); }
  }
  const failure = new Error('option getter failed');
  const options = { get key() { throw failure; } };
  await equal(file, options);
  await equal(path.join(home, 'absent'), options);
  assert.equal(await candidate(null, 'target', options), null);
  assert.equal(await candidate(file, null, options), null);
  fs.writeFileSync(file, JSON.stringify(signed(1, measurement(2))));
  assert.equal((await candidate(file, 'target', { key })).latestObservation.value, 2);
});

test('mid-read failures outrank option failures and close the opened file', async () => {
  const originalOpen = fsp.open;
  const originalReadFile = fsp.readFile;
  const readError = Object.assign(new Error('injected read failure'), { code: 'EIO' });
  const options = { get key() { throw new Error('option failure'); } };
  let reads = 0;
  let closed = false;
  fsp.open = async () => ({
    stat: async () => ({ isFile: () => true, size: 10 }),
    read: async (buffer) => {
      if (reads++ === 0) { buffer.write('{}\n'); return { bytesRead: 3 }; }
      throw readError;
    },
    close: async () => { closed = true; },
  });
  fsp.readFile = async () => { throw readError; };
  try { await equal(file, options); assert.equal(closed, true); }
  finally { fsp.open = originalOpen; fsp.readFile = originalReadFile; }
});

test('read and close failures preserve native aggregate ordering and error details', async () => {
  const originalOpen = fsp.open;
  const originalReadFile = fsp.readFile;
  const readError = Object.assign(new Error('read failed'), { code: 'EIO' });
  const closeError = Object.assign(new Error('close failed'), { code: 'EBADF' });
  const expected = new AggregateError([readError, closeError], readError.message);
  expected.code = readError.code;
  fsp.open = async () => ({
    stat: async () => ({ isFile: () => true, size: 10 }),
    read: async () => { throw readError; },
    close: async () => { throw closeError; },
  });
  fsp.readFile = async () => { throw expected; };
  try { await equal(); }
  finally { fsp.open = originalOpen; fsp.readFile = originalReadFile; }
});

test('regular-file replay remains bounded by the initial size when events append', async () => {
  const originalOpen = fsp.open;
  const initial = Buffer.from(JSON.stringify(signed(1, measurement(1))) + '\n');
  const appended = Buffer.from(JSON.stringify(signed(2, measurement(2))) + '\n');
  const content = Buffer.concat([initial, appended]);
  let position = 0;
  let closed = false;
  fsp.open = async () => ({
    stat: async () => ({ isFile: () => true, size: initial.length }),
    read: async (buffer, offset, length) => {
      const bytesRead = content.copy(buffer, offset, position, position + length);
      position += bytesRead;
      return { bytesRead };
    },
    close: async () => { closed = true; },
  });
  try {
    assert.equal((await candidate(file, 'target', { key })).latestObservation.value, 1);
    assert.equal(position, initial.length);
    assert.equal(closed, true);
  } finally { fsp.open = originalOpen; }
});

test('FIFO replay uses one reader rendezvous and matches the baseline', { skip: process.platform === 'win32' }, async (t) => {
  const fifo = path.join(home, 'events.fifo');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (created.error?.code === 'ENOENT') { t.skip('mkfifo is unavailable'); return; }
  assert.equal(created.status, 0, created.stderr);
  for (const module of ['../lib/orchestrator.js', './fixtures/event-bridge-evidence.mjs']) {
    const code = `import { readEventBridgeEvidence } from ${JSON.stringify(new URL(module, import.meta.url).href)}; console.log(JSON.stringify(await readEventBridgeEvidence(process.argv[1], 'target', { key: process.argv[2] })));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, fifo, key]);
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FIFO replay timed out')); }, 5000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', (status) => { clearTimeout(timer); resolve(status); });
    });
    await fsp.writeFile(fifo, JSON.stringify(signed(1, measurement(7))) + '\n');
    assert.equal(await done, 0, stderr);
    assert.equal(JSON.parse(output).latestObservation.value, 7);
  }
});
