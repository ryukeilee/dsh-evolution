import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { claimConsumerSession, consumerStateDocument, readConsumerState, sharingPaths, writeConsumerState } from '../lib/promoted-sharing.js';

// A real old host waits across a new host's claim + activation, then attempts
// both its late startup report and shutdown report in a different process.
test('cross-process state CAS rejects an older host after a new activation', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'consumer-process-state-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const moduleUrl = new URL('../lib/promoted-sharing.js', import.meta.url).href;
  const script = `
    import { claimConsumerSession, consumerStateDocument, writeConsumerState } from ${JSON.stringify(moduleUrl)};
    const paths = { dataRoot: process.argv[1] };
    await claimConsumerSession(paths, 'acp', 'old');
    process.send('claimed');
    process.once('message', async () => {
      const state = { ...consumerStateDocument({ profile: 'acp', plugins: [{ id: 'fixture', status: 'failed' }] }), sessionId: 'old' };
      const mount = await writeConsumerState(paths, 'acp', state, { sessionId: 'old' });
      const dispose = await writeConsumerState(paths, 'acp', { ...state, disposedAt: new Date().toISOString() }, { sessionId: 'old' });
      process.send({ mount, dispose });
      process.disconnect();
    });
  `;
  const old = spawn(process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', script, dataRoot], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => old.kill());
  let errors = '';
  old.stderr.on('data', bytes => { errors += bytes; });
  assert.equal((await once(old, 'message'))[0], 'claimed');
  const paths = sharingPaths({ dataRoot });
  await claimConsumerSession(paths, 'acp', 'new');
  const state = { ...consumerStateDocument({ profile: 'acp', plugins: [{ id: 'fixture', status: 'active' }] }), sessionId: 'new' };
  await writeConsumerState(paths, 'acp', state, { sessionId: 'new' });
  const response = once(old, 'message');
  const exit = once(old, 'exit');
  old.send('finish');
  assert.deepEqual((await response)[0], { mount: null, dispose: null });
  assert.equal((await exit)[0], 0, errors);
  assert.deepEqual((await readConsumerState(paths, 'acp')).state, state);
});
