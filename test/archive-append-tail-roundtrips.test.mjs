import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EvolutionMemory } from '../lib/dockyard-domain/memory.js';

// Inject only into the tail probe, leaving load/index/cache filesystem work
// real. Patching the builtins is scoped to one serial test and always undone.
const inTailProbe = () => new Error().stack.includes('#activeTailIsTorn');
const at = '2026-01-01T00:00:00.000Z';
const hot = ['first', 'second', 'third'].map((message, index) => ({
  id: `hot-${index}`, type: 'tool/error', componentId: 'tool', message, recordedAt: at,
}));

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'archive-tail-fault-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = join(directory, 'state.json');
    const archive = `${filePath}.observations-archive.jsonl`;
    const original = `${JSON.stringify({ id: 'cold', recordedAt: at })}\n`;
    await writeFile(archive, original);
    let aggregate = { evolution: {
      schema: 4, observations: hot,
      coldArchives: { observations: { schema: 2, count: 1, file: archive, activeFile: archive, segments: [] } },
    } };
    const stateStore = {
      filePath, load: async () => structuredClone(aggregate),
      update: async updater => { aggregate = updater(aggregate); await writeFile(filePath, JSON.stringify(aggregate)); },
    };
    const open = () => new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update },
      mutationAuthority: { assertMutation() {} }, hotEntries: 2 });
    return { archive, original, open, memory: open() };
}

for (const failure of ['stat', 'open', 'read', 'close', 'short-read', 'mkdir', 'initial-stat']) {
  test(`archive ${failure}: real load preserves the established failure boundary`, async t => {
    const { archive, original, memory } = await fixture(t);
    const real = Object.fromEntries(['statSync', 'openSync', 'readSync', 'closeSync', 'mkdirSync'].map(name => [name, fs[name]]));
    let injected = 0;
    let opened;
    let closed = 0;
    const error = () => Object.assign(new Error(`injected tail ${failure}`), { code: 'EIO' });
    try {
      fs.statSync = (...args) => {
        if (inTailProbe() && failure === 'stat') { injected++; throw error(); }
        // The initial size probe is the only non-bigint stat inside run(),
        // outside the tail helper. Cache identities use bigint stats.
        if (failure === 'initial-stat' && args[0] === archive && args[1] === undefined
          && !inTailProbe() && new Error().stack.includes('at run ')) {
          injected++; throw error();
        }
        return real.statSync(...args);
      };
      fs.mkdirSync = (...args) => {
        if (failure === 'mkdir' && new Error().stack.includes('at run ')) { injected++; throw error(); }
        return real.mkdirSync(...args);
      };
      fs.openSync = (...args) => {
        if (!inTailProbe()) return real.openSync(...args);
        if (failure === 'open') { injected++; throw error(); }
        opened = real.openSync(...args);
        return opened;
      };
      fs.readSync = (...args) => {
        if (inTailProbe()) {
          assert.equal(args[3], 1, 'tail reads exactly one byte');
          if (failure === 'read') { injected++; throw error(); }
          if (failure === 'short-read') { injected++; return 0; }
        }
        return real.readSync(...args);
      };
      fs.closeSync = fd => {
        if (!inTailProbe()) return real.closeSync(fd);
        assert.equal(fd, opened);
        closed++;
        // Simulate a close reporting failure after releasing the descriptor;
        // the read-failure case separately proves finally actually closes it.
        const result = real.closeSync(fd);
        if (failure === 'close') { injected++; throw error(); }
        return result;
      };
      syncBuiltinESMExports();
      await memory.load();
    } finally {
      Object.assign(fs, real);
      syncBuiltinESMExports();
    }
    {
      assert.equal(injected, 1, 'the intended tail operation must be reached');
      if (opened !== undefined) {
        assert.equal(closed, 1);
        assert.throws(() => fs.fstatSync(opened), { code: 'EBADF' });
      }
      if (['open', 'read', 'close', 'mkdir'].includes(failure)) {
        assert.deepEqual(memory.snapshot().observations.map(row => row.id), hot.map(row => row.id));
        assert.ok(memory.archiveIntegrity().observations.some(fault => fault.kind === 'deferred-write' && fault.code === 'EIO'));
        assert.equal(await readFile(archive, 'utf8'), original, 'failed probe cannot append bytes or evict the hot row');
      } else {
        // stat failure and EOF were already interpreted as "not torn". Keep
        // that behavior: a healthy newline-terminated archive remains writable.
        const rows = (await readFile(archive, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.deepEqual(rows.map(row => row.id), ['cold', 'hot-0']);
        assert.deepEqual(memory.history('observations').map(row => row.id), ['cold', ...hot.map(row => row.id)]);
      }
    }
  });
}

for (const change of ['same-length-replace', 'truncate']) {
  test(`external ${change}: append and restart preserve hot rows and current archive bytes`, async t => {
    const { archive, memory, open } = await fixture(t);
    await memory.load();
    const bytes = await readFile(archive, 'utf8');
    if (change === 'same-length-replace') {
      const replacement = bytes.replace('"cold"', '"NEW!"');
      assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(bytes));
      const temporary = `${archive}.replacement`;
      await writeFile(temporary, replacement);
      fs.renameSync(temporary, archive);
    } else {
      // Remove only the previously cold row; every remaining byte is a whole
      // record. The hot rows present before the external change must survive.
      await writeFile(archive, '');
    }
    const retainedHotIds = memory.snapshot().observations.map(row => row.id);
    await memory.recordObservation({ id: 'hot-extra', type: 'tool/error', componentId: 'tool',
      message: 'fourth', recordedAt: at });
    const restarted = open();
    await restarted.load();
    const rows = restarted.history('observations');
    for (const id of [...retainedHotIds, 'hot-extra']) {
      assert.ok(rows.some(row => row.id === id), `${id} remains readable after restart`);
    }
    if (change === 'same-length-replace') {
      assert.ok(rows.some(row => row.id === 'NEW!'));
      assert.ok(!rows.some(row => row.id === 'cold'), 'replacement is not overwritten by a cached predecessor');
    } else {
      assert.ok(!rows.some(row => row.id === 'cold'), 'truncated cold bytes are not invented by the cache');
    }
    const archived = (await readFile(archive, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(archived.some(row => row.id === retainedHotIds[0]), 'the next evicted hot row was appended');
  });
}
