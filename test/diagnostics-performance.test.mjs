import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, resolveEvolutionPaths, inspectJsonLines } from '../lib/diagnostics.js';
import { collectDiagnostics as baseline, inspectJsonLines as oldInspect } from './fixtures/diagnostics.mjs';

const normalize = (report) => { delete report.generatedAt; return report; };

test('cold history diagnostics match the baseline across valid, damaged and absent files', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-differential-'));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dockyardDir, { recursive: true });
  fs.writeFileSync(paths.keyPath, 'a'.repeat(64), { mode: 0o600 });
  const state = path.join(paths.dockyardDir, 'state.json');
  const history = path.join(paths.dockyardDir, 'state.json.observations.jsonl');
  const options = { dshHome: home, probe: { skipComposition: true } };
  try {
    for (const content of [null, '{broken', 'null', '{}', '{"evolution":{"schema":4,"observations":[{"payload":"large"}],"proposals":[]}}']) {
      if (content === null) fs.rmSync(state, { force: true });
      else fs.writeFileSync(state, content);
      for (const lines of ['', '\n', '\n\n', ' \r\n', '{}\n', '{}', '{}\r\nnull\n\n', '{broken\n{}\n', '{}\n{broken', 'null\nfalse\n42\n"x"\n']) {
        fs.writeFileSync(history, lines);
        const before = fs.readFileSync(history);
        assert.deepEqual(normalize(await collectDiagnostics(options)), normalize(await baseline(options)));
        assert.deepEqual(inspectJsonLines(lines), oldInspect(lines));
        assert.deepEqual(fs.readFileSync(history), before);
      }
    }
    // No cross-call cache: a rewrite is visible on the next diagnostic run.
    fs.writeFileSync(state, '{"evolution":{"schema":4,"observations":[1,2,3]}}');
    const report = await collectDiagnostics(options);
    assert.equal(report.checks.find((check) => check.id === 'state.dockyard-legacy').evidence.counts.observations, 3);
    const original = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(file, ...args) { if (String(file) === state) reads += 1; return original.call(this, file, ...args); };
    try { await collectDiagnostics(options); } finally { fs.readFileSync = original; }
    assert.equal(reads, 1, 'the aggregate is read once per report');
    fs.rmSync(state);
    assert.equal((await collectDiagnostics(options)).checks.some((check) => check.id === 'state.dockyard-legacy'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
