import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planEventLogReplay, eventLogCheckpointDocument } from '../../lib/event-log-checkpoint.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const key = 'chunk-boundary-test-key';
const writer = 'dsh-evolution-orchestrator';

// The pre-change reader differs by its chunk size alone. Compare all public plan
// fields and checkpoint bytes, including native HMAC equality, on the same file.
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-read-chunks-'));
  fs.cpSync(path.join(root, 'lib'), path.join(directory, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  const module = path.join(directory, 'lib/event-log-checkpoint.js');
  const source = fs.readFileSync(module, 'utf8');
  assert.equal(source.split('const READ_CHUNK_BYTES = 1 << 16;').length, 2);
  fs.writeFileSync(module, source.replace('const READ_CHUNK_BYTES = 1 << 16;', 'const READ_CHUNK_BYTES = 1 << 20;'));
  const baseline = await import(pathToFileURL(module).href);
  const file = path.join(directory, 'events.jsonl');
  return { directory, file, baseline, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
const native = bytes => crypto.createHmac('sha256', key).update(bytes).digest('hex');

test('64 KiB replay reads preserve plans and checkpoint bytes across read boundaries', async () => {
  const f = await fixture();
  try {
    for (const size of [1, 65535, 65536, 65537, 1048575, 1048576, 1048577]) {
      const bytes = Buffer.alloc(size, 0x20); bytes[size-1] = 0x0a;
      fs.writeFileSync(f.file, bytes);
      const initial = planEventLogReplay({ file: f.file, key, writer });
      const checkpoint = eventLogCheckpointDocument({ plan: initial, writer, key, applied: {} });
      assert.equal(checkpoint.digest, native(bytes));
      for (const tail of ['', ' \n', 'unterminated']) {
        fs.writeFileSync(f.file, Buffer.concat([bytes, Buffer.from(tail)]));
        for (const candidate of [checkpoint, { ...checkpoint, mac: '0'.repeat(64) }, null]) {
          const options = { file: f.file, key, writer, checkpoint: candidate, applied: {} };
          const actual = planEventLogReplay(options);
          const expected = f.baseline.planEventLogReplay(options);
          assert.deepEqual(actual, expected, `size ${size}, tail ${JSON.stringify(tail)}`);
          assert.deepEqual(eventLogCheckpointDocument({ plan: actual, writer, key, applied: {} }),
            f.baseline.eventLogCheckpointDocument({ plan: expected, writer, key, applied: {} }));
        }
      }
    }
  } finally { f.close(); }
});

test('short reads and read failures preserve authentication and close the log descriptor', async () => {
  const f = await fixture();
  const read = fs.readSync;
  const close = fs.closeSync;
  try {
    const bytes = Buffer.alloc(140001, 0x20); bytes[bytes.length-1] = 0x0a;
    fs.writeFileSync(f.file, bytes);
    const initial = planEventLogReplay({ file: f.file, key, writer });
    const checkpoint = eventLogCheckpointDocument({ plan: initial, writer, key, applied: {} });
    const options = { file: f.file, key, writer, checkpoint, applied: {} };
    fs.readSync = (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 701), position);
    const actual = planEventLogReplay(options);
    const expected = f.baseline.planEventLogReplay(options);
    assert.deepEqual(actual, expected);
    assert.equal(actual.trusted, true);
    assert.equal(actual.next.digest, native(bytes));
    for (const plan of [planEventLogReplay, f.baseline.planEventLogReplay]) {
      let reads = 0, closes = 0;
      fs.closeSync = fd => { closes++; return close(fd); };
      const error = Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
      fs.readSync = (...args) => { if (++reads === 2) throw error; return read(...args); };
      assert.throws(() => plan(options), thrown => thrown === error);
      assert.equal(closes, 1);
    }
  } finally { fs.readSync = read; fs.closeSync = close; f.close(); }
});
