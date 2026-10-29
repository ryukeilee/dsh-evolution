import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EvolutionMemory } from '../lib/dockyard-domain/memory.js';

const at = '2026-10-29T00:00:00.000Z';
const signal = id => ({ id, type: 'tool/error', componentId: 'sync-append', message: id,
  recordedAt: at, forceRecord: true });
const ids = memory => memory.history('observations').map(row => row.id);

async function fixture(t, guard) {
  const directory = await fsp.mkdtemp(join(tmpdir(), 'archive-staged-sync-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'state.json');
  const archive = `${filePath}.observations-archive.jsonl`;
  await fsp.writeFile(filePath, JSON.stringify({ evolution: { schema: 4, observations: [], coldArchives: {} } }));
  const stateStore = {
    filePath,
    load: async () => JSON.parse(await fsp.readFile(filePath, 'utf8')),
    update: async updater => {
      const before = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      await fsp.writeFile(filePath, JSON.stringify(updater(before)));
    },
  };
  const open = async () => {
    const memory = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update },
      mutationAuthority: { assertMutation() {} }, archiveWriteGuard: guard,
      hotEntries: 1, archiveMaxBytes: 64 * 1024, clock: () => new Date(at) });
    await memory.load();
    return memory;
  };
  const memory = await open();
  await memory.recordObservation(signal('a'));
  await memory.recordObservation(signal('b'));
  return { archive, memory, open, original: await fsp.readFile(archive, 'utf8') };
}

// Builtin patches affect named ESM imports too. Keep each patch inside a serial
// test's try/finally and match only this fixture's archive, leaving storage real.
async function withAppendHooks(archive, hooks, work) {
  const sync = fs.appendFileSync;
  const asyncAppend = fsp.appendFile;
  try {
    fs.appendFileSync = (...args) => args[0] === archive && hooks.sync
      ? hooks.sync(() => sync(...args)) : sync(...args);
    fsp.appendFile = (...args) => args[0] === archive && hooks.async
      ? hooks.async(() => asyncAppend(...args)) : asyncAppend(...args);
    syncBuiltinESMExports();
    await work();
  } finally {
    fs.appendFileSync = sync;
    fsp.appendFile = asyncAppend;
    syncBuiltinESMExports();
  }
}

const assertDeferred = memory => assert.ok(memory.archiveIntegrity().observations
  .some(fault => fault.kind === 'deferred-write' && fault.code === 'EIO'));

test('staged sync append failure preserves bytes and hot rows, then retry and disk reload retain every row', async t => {
  let guarded = false;
  const { archive, memory, open, original } = await fixture(t, async () => { guarded = true; });
  guarded = false;
  let calls = 0;
  await withAppendHooks(archive, {
    sync() {
      calls++;
      assert.equal(guarded, true, 'the write guard finishes before sync append');
      throw Object.assign(new Error('injected sync append failure'), { code: 'EIO' });
    },
    async() { assert.fail('guarded chunk must use sync append'); },
  }, async () => {
    await memory.recordObservation(signal('c'));
  });
  assert.equal(calls, 1, 'the intended sync append was reached');
  assert.equal(await fsp.readFile(archive, 'utf8'), original);
  assert.deepEqual(memory.snapshot().observations.map(row => row.id), ['b', 'c']);
  assert.deepEqual(ids(memory), ['a', 'b', 'c']);
  assertDeferred(memory);

  await memory.recordObservation(signal('d'));
  assert.deepEqual((await fsp.readFile(archive, 'utf8')).trim().split('\n').map(JSON.parse).map(row => row.id),
    ['a', 'b', 'c'], 'retry archives the failed row exactly once');
  assert.deepEqual(ids(memory), ['a', 'b', 'c', 'd']);
  assert.ok(!(memory.archiveIntegrity().observations ?? []).some(fault => fault.kind === 'deferred-write'));
  const reloaded = await open();
  assert.deepEqual(ids(reloaded), ['a', 'b', 'c', 'd'], 'reload reads the actual persisted state and archive');
});

test('without an archive guard chunk append remains asynchronous', async t => {
  const { archive, memory, open } = await fixture(t, null);
  let calls = 0;
  await withAppendHooks(archive, {
    sync() { assert.fail('unguarded chunk must not use sync append'); },
    async(append) { calls++; return append(); },
  }, async () => {
    await memory.recordObservation(signal('c'));
  });
  assert.equal(calls, 1);
  assert.deepEqual(ids(await open()), ['a', 'b', 'c']);
});

test('a rejected archive guard prevents either append and keeps the evicted row hot', async t => {
  let reject = false;
  let guarded = 0;
  const { archive, memory, open, original } = await fixture(t, async () => {
    if (reject) {
      guarded++;
      throw Object.assign(new Error('injected guard refusal'), { code: 'EIO' });
    }
  });
  reject = true;
  await withAppendHooks(archive, {
    sync() { assert.fail('guard refusal must precede sync append'); },
    async() { assert.fail('guard refusal must precede async append'); },
  }, async () => {
    await memory.recordObservation(signal('c'));
  });
  assert.equal(guarded, 1);
  assert.equal(await fsp.readFile(archive, 'utf8'), original);
  assert.deepEqual(memory.snapshot().observations.map(row => row.id), ['b', 'c']);
  assertDeferred(memory);
  reject = false;
  assert.deepEqual(ids(await open()), ['a', 'b', 'c'], 'reload recovers the retained hot row');
});
