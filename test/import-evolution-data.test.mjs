import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importEvolutionData } from '../scripts/import-evolution-data.mjs';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evolution-import-'));
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'knowledge/archive/2026/experiments'), { recursive: true });
  await fs.writeFile(path.join(source, 'knowledge/evolution-memory.json'), JSON.stringify({ schema: 1, entries: [{ id: 'existing' }] }));
  await fs.writeFile(path.join(source, 'EVOLUTION.md'), '# Existing protocol\n');
  await fs.writeFile(path.join(source, 'knowledge/archive/2026/experiments/exp-1.md'), '# Experiment 1\n');
  return { root, source, destination: path.join(root, 'destination') };
}
test('repeat import never duplicates or overwrites evolved active memory', async () => {
  const f = await fixture();
  const first = await importEvolutionData({ presetSnapshot: f.source, destination: f.destination });
  assert.equal(first.status, 'imported');
  await fs.writeFile(path.join(f.destination, 'evolution-memory.json'), JSON.stringify({ schema: 1, entries: [{ id: 'existing' }, { id: 'new' }] }));
  const second = await importEvolutionData({ presetSnapshot: f.source, destination: f.destination });
  assert.equal(second.status, 'already-imported');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, 'evolution-memory.json'))).entries.length, 2);
});
test('a competing migration lock fails before staging and is left untouched', async () => {
  const f = await fixture();
  const lockPath = `${f.destination}.migration.lock`;
  await fs.writeFile(lockPath, '424242', { mode: 0o600 });
  await assert.rejects(importEvolutionData({ presetSnapshot: f.source, destination: f.destination }),
    /migration lock already exists/);
  assert.equal(await fs.readFile(lockPath, 'utf8'), '424242', 'the other import lock is never replaced or removed');
  const staged = async () => (await fs.readdir(f.root))
    .filter((name) => name.startsWith(`${path.basename(f.destination)}.migration-`));
  assert.deepEqual(await staged(), [], 'a refused import must not leave a staged copy of the source behind');
  await assert.rejects(fs.access(f.destination), { code: 'ENOENT' });

  // Once the foreign lock is gone the import runs, and its own lock and stage
  // are released by the same finally that owns them.
  await fs.unlink(lockPath);
  assert.equal((await importEvolutionData({ presetSnapshot: f.source, destination: f.destination })).status, 'imported');
  assert.deepEqual(await staged(), []);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});
test('the release removes only the migration lock this import created', async () => {
  const f = await fixture();
  const lockPath = `${f.destination}.migration.lock`;
  const originalWriteFile = fs.writeFile;
  let injected = false;
  // While this run writes its manifest another process takes the path: this
  // import's lock is gone, so the replacement belongs to whoever wrote it, and
  // the injection then makes this run fail. The failure path must not remove it.
  fs.writeFile = async function injectedManifestWrite(target, ...rest) {
    if (!injected && String(target).endsWith('migration-manifest.json')) {
      injected = true;
      await fs.unlink(lockPath);
      await originalWriteFile.call(fs, lockPath, '424242', { flag: 'wx', mode: 0o600 });
      throw new Error('injected manifest failure');
    }
    return originalWriteFile.call(fs, target, ...rest);
  };
  try {
    await assert.rejects(importEvolutionData({ presetSnapshot: f.source, destination: f.destination }), /injected manifest failure/);
  } finally { fs.writeFile = originalWriteFile; }
  assert.equal(injected, true, 'the replacement must have happened while the manifest was written');
  assert.equal(await fs.readFile(lockPath, 'utf8'), '424242', 'a lock replaced during the import is left where its owner put it');
  await assert.rejects(fs.access(f.destination), { code: 'ENOENT' });
});

test('a second importer that lost the race returns already-imported without staging', async () => {
  const f = await fixture();
  const lockPath = `${f.destination}.migration.lock`;
  const originalOpen = fs.open;
  let raced = false;
  // The completion check runs before the lock is taken. This hook makes a
  // competing importer finish and release the path in between, so the loser's
  // pre-lock read is stale and only a re-read under its own lock can see the
  // completed import.
  fs.open = async function racedLockOpen(target, ...rest) {
    if (!raced && String(target) === lockPath) {
      raced = true;
      const winner = await importEvolutionData({ presetSnapshot: f.source, destination: f.destination });
      assert.equal(winner.status, 'imported');
    }
    return originalOpen.call(fs, target, ...rest);
  };
  let result;
  try { result = await importEvolutionData({ presetSnapshot: f.source, destination: f.destination }); }
  finally { fs.open = originalOpen; }
  assert.equal(raced, true, 'the competing import must complete before the lock is taken');
  assert.equal(result.status, 'already-imported', 'the stale pre-lock read must be rechecked under the lock');
  assert.equal(result.files, JSON.parse(await fs.readFile(path.join(f.destination, 'migration-manifest.json'), 'utf8')).files.length);
  assert.deepEqual((await fs.readdir(f.root)).filter((name) => name.startsWith(`${path.basename(f.destination)}.migration-`) && !name.endsWith('.lock')), [],
    'the losing importer must not leave a staged copy beside the destination');
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' }, 'the losing importer releases the lock it took');
});

test('changed source conflicts without overwriting destination', async () => {
  const f = await fixture();
  await importEvolutionData({ presetSnapshot: f.source, destination: f.destination });
  await fs.writeFile(path.join(f.source, 'EVOLUTION.md'), 'changed');
  await assert.rejects(importEvolutionData({ presetSnapshot: f.source, destination: f.destination }), /different source/);
  assert.equal(await fs.readFile(path.join(f.destination, 'EVOLUTION.md'), 'utf8'), '# Existing protocol\n');
});
test('pending legacy promotion fails closed and preserves source', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.source, '.evolution-promotion'));
  await fs.writeFile(path.join(f.source, '.evolution-promotion/journal.json'), JSON.stringify({ phase: 'canary-observing' }));
  await assert.rejects(importEvolutionData({ presetSnapshot: f.source, destination: f.destination }), /explicit recovery/);
  await assert.rejects(fs.access(f.destination), { code: 'ENOENT' });
});
