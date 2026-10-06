import { test, assert, summary, registerCleanup } from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-archive-md-'));
registerCleanup(scratch);

await test('parseArchiveMdEvidence: parses populated Observations JSON blocks', async () => {
  const md = [
    '# Evolution experiment exp-parse-1',
    '',
    '- state: stable',
    '- terminal reason: stable-commit',
    '- owner: session-a',
    '',
    '## Proposal',
    '- why: w',
    '- target: t',
    '',
    '## Observations',
    '```json',
    '[{"id": "obs-1", "solvesProblem": true, "metrics": {"x": 0}}]',
    '```',
    '',
    '## Latest measurement',
    '```json',
    '{"id": "obs-1", "solvesProblem": true, "sampleCount": 2}',
    '```',
    '',
    '## Runtime recovery',
    '- recovered: true',
    '- proof: {"status":"recovered"}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(scratch, 'exp-parse-1.md'), md);
  const parsed = await mod.readArchiveMdEvidence(scratch, 'exp-parse-1');
  assert(parsed, 'archive md parsed');
  assert(Array.isArray(parsed.observations) && parsed.observations.length === 1, 'observations parsed from JSON block');
  assert(parsed.observations[0].id === 'obs-1', 'observation content parsed');
  assert(parsed.latestObservation && parsed.latestObservation.sampleCount === 2, 'latest measurement parsed');
  assert(parsed.runtimeRecovered === true, 'recovered flag parsed');
});

await test('parseArchiveMdEvidence: missing sections stay missing (no fabrication)', async () => {
  const md = [
    '# Evolution experiment exp-parse-2',
    '',
    '## Observations',
    '```json',
    '[]',
    '```',
    '',
    '## Runtime recovery',
    '- recovered: false',
    '- proof: {"status":"unknown"}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(scratch, 'exp-parse-2.md'), md);
  const parsed = await mod.readArchiveMdEvidence(scratch, 'exp-parse-2');
  assert(parsed, 'archive md parsed');
  assert(parsed.observations.length === 0, 'empty observations stay empty');
  assert(parsed.latestObservation === null, 'missing latest stays null');
  assert(parsed.runtimeRecovered === false, 'recovered stays false');
});

summary();