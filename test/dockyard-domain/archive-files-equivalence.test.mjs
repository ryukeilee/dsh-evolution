import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { JsonStateStore } from './support.js';

function authority() { return { assertMutation() {}, isActive: () => true }; }

test('cold archive file listing matches the old indexOf order with many segments', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-archive-files-equivalence-'));
  try {
    const stateStore = new JsonStateStore({ home });
    const active = `${stateStore.filePath}.observations-archive.jsonl`;
    const directory = `${active}.segments`;
    await mkdir(directory, { recursive: true });

    // Insert out of order and use non-padded numbers so lexical ordering is
    // visible (segment-1, segment-10, segment-2). The production filter then
    // sorts these names before adding the active archive last.
    const insertionOrder = Array.from({ length: 360 }, (_, index) => index + 1)
      .sort((left, right) => ((left * 73) % 367) - ((right * 73) % 367));
    const names = insertionOrder.map((number) => `segment-${number}.jsonl`);
    for (const [index, name] of names.entries()) {
      await writeFile(join(directory, name), `${JSON.stringify({ id: `segment-record-${index}`, recordedAt: '2026-08-26T00:00:00.000Z' })}\n`);
    }
    await writeFile(active, `${JSON.stringify({ id: 'active-record', recordedAt: '2026-08-27T00:00:00.000Z' })}\n`);

    const sortedNames = await readdir(directory);
    const oldIndexOfListing = [...sortedNames.filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort().map((name) => join(directory, name)), active]
      .filter((file, index, files) => files.indexOf(file) === index);
    assert.equal(oldIndexOfListing.at(-1), active, 'active archive remains last');
    // A segment basename must match segment-N.jsonl while the active archive
    // basename is state.json.observations-archive.jsonl, so the duplicate-path
    // case cannot be produced by this listing's filename rules.
    assert.equal(names.includes(active.split('/').at(-1)), false);

    const memory = new EvolutionMemory({ stateStore, hotEntries: 2, archiveMaxBytes: 1024 });
    memory.setMutationAuthority(authority());
    await memory.load();
    const index = JSON.parse(await readFile(`${stateStore.filePath}.evolution-archive-index.json`, 'utf8'));
    const actualListing = index.segments
      .filter((entry) => entry.collection === 'observations')
      .map((entry) => entry.file === active.split('/').at(-1) ? active : join(directory, entry.file));
    assert.deepEqual(actualListing, oldIndexOfListing);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
