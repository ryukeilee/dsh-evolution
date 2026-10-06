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
