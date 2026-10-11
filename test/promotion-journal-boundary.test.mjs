// The doctor and recovery now share one promotion-journal boundary rule, so both
// refuse the same journals for the same reason and leave the journal in place.
//
// This is a BEHAVIOURAL change, not a pure-equivalence refactor, and it is not
// part of the archive-index performance work:
//   * Recovery already refused the same SET of journals, but the error TYPE
//     changed too: a bare `TypeError` (e.g. `path.resolve(undefined)`, or a
//     non-string `stageDir`) is now a clean `Error` carrying a reason, and the
//     message text changed (`Evolution promotion journal recovery refused: ...`).
//   * The doctor's classification genuinely changes for a `symlink` record: it
//     used to report `degraded`/`incomplete`/`recoverable: true` and offered a
//     `promotion-journal-recover` repair, while recovery always rejected it.
//     A `symlink` record is now `blocked`/`state-unknown`/`recoverable: false`
//     with no repair offered. That is a real bug fix: the old doctor offered a
//     repair that recovery would then refuse.
// This test pins both the shared verdict and the `symlink` -> blocked case.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { checkJournalBoundary as recoveryBoundary, recoverInterruptedPromotion } from '../lib/orchestrator.js';
import { checkJournalBoundary as diagnosticBoundary, collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';

async function scratch(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-journal-boundary-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** `presetDir` is deliberately narrower than `dataRoot`: the old doctor used
 * `dataRoot` and therefore accepted targets that recovery rejected. */
async function fixture(t, name) {
  const dataRoot = await scratch(t, name);
  const presetDir = path.join(dataRoot, 'preset');
  const paths = {
    dshHome: path.join(dataRoot, 'home'),
    dataRoot,
    presetDir,
    presetId: 'evolution',
    pluginRoot: path.join(presetDir, 'promoted'),
    compositionPath: path.join(presetDir, 'promoted.cordis.yml'),
    evolutionPath: path.join(presetDir, 'EVOLUTION.md'),
    archiveDir: path.join(presetDir, 'archive', 'experiments'),
    promotionStateDir: path.join(presetDir, 'promotion'),
    promotionLockPath: path.join(presetDir, 'promotion.lock'),
  };
  await fs.mkdir(paths.promotionStateDir, { recursive: true, mode: 0o700 });
  return { dataRoot, presetDir, paths };
}

const baseJournal = (paths, overrides = {}) => ({
  version: 1,
  phase: 'committing',
  experimentId: 'exp-boundary-1',
  stateDir: paths.promotionStateDir,
  stageDir: path.join(paths.promotionStateDir, 'stage'),
  records: [],
  ...overrides,
});

async function writeJournal(paths, journal) {
  const file = path.join(paths.promotionStateDir, 'journal.json');
  await fs.writeFile(file, JSON.stringify(journal, null, 2));
  return file;
}

const cases = [
  {
    name: 'a legal journal',
    reason: null,
    journal: (paths) => baseJournal(paths, { records: [{ type: 'path', target: path.join(paths.pluginRoot, 'promoted-plugin') }] }),
  },
  {
    name: 'a symlink record, which recovery never accepted',
    reason: /unsupported shape/,
    journal: (paths) => baseJournal(paths, { records: [{ type: 'symlink', target: path.join(paths.pluginRoot, 'link') }] }),
  },
  {
    name: 'a record with a non-string target',
    reason: /unsupported shape/,
    journal: (paths) => baseJournal(paths, { records: [{ type: 'file', target: 42 }] }),
  },
  {
    name: 'a target only inside dataRoot but outside the preset',
    reason: /outside the configured roots/,
    journal: (paths, { dataRoot }) => baseJournal(paths, { records: [{ type: 'path', target: path.join(dataRoot, 'elsewhere') }] }),
  },
  {
    name: 'a target outside every configured root',
    reason: /outside the configured roots/,
    journal: (paths) => baseJournal(paths, { records: [{ type: 'path', target: path.join(os.tmpdir(), 'evo-journal-not-managed') }] }),
  },
  {
    name: 'a record targeting the promotion state directory',
    reason: /own state directory/,
    journal: (paths) => baseJournal(paths, { records: [{ type: 'path', target: path.join(paths.promotionStateDir, 'backups', 'x') }] }),
  },
  {
    name: 'a file record with an escaping backup name',
    reason: /bare file name/,
    journal: (paths) => baseJournal(paths, { records: [{ type: 'file', target: paths.evolutionPath, backup: '../escape.bak' }] }),
  },
  {
    name: 'a stateDir outside the configured promotion state directory',
    reason: /outside the configured promotion state directory/,
    journal: (paths) => baseJournal(paths, { stateDir: path.join(paths.presetDir, 'other') }),
  },
  {
    name: 'a missing stateDir',
    reason: /outside the configured promotion state directory/,
    journal: (paths) => { const journal = baseJournal(paths); delete journal.stateDir; return journal; },
  },
  {
    name: 'a stageDir outside its state directory',
    reason: /stageDir escapes/,
    journal: (paths) => baseJournal(paths, { stageDir: path.join(paths.presetDir, 'stage-escape') }),
  },
  {
    name: 'a non-string stageDir',
    reason: /stageDir escapes/,
    journal: (paths) => baseJournal(paths, { stageDir: 42 }),
  },
  {
    name: 'records that are not an array',
    reason: /no change plan/,
    journal: (paths) => baseJournal(paths, { records: {} }),
  },
];

for (const [index, entry] of cases.entries()) {
  await test(`recovery and the doctor agree: ${entry.name}`, async (t) => {
    const { paths, dataRoot } = await fixture(t, `case-${index}`);
    const journal = entry.journal(paths, { dataRoot });
    const file = await writeJournal(paths, journal);

    const reported = diagnosticBoundary(journal, paths);
    assert.equal(reported, recoveryBoundary(journal, paths), 'the doctor and recovery must share one verdict');

    if (entry.reason === null) {
      assert.equal(reported, null);
      assert.equal((await recoverInterruptedPromotion(paths)).status, 'rolled-back');
      await assert.rejects(fs.access(file));
      return;
    }

    assert.match(reported, entry.reason);
    const report = await collectDiagnostics({
      paths: { ...resolveEvolutionPaths({ dshHome: paths.dshHome, dataRoot }), ...paths },
      home: true, probe: { skipComposition: true },
    });
    const check = report.checks.find((candidate) => candidate.id === 'promotion.journal');
    assert.equal(check.level, 'blocked');
    assert.equal(check.evidence.state, 'state-unknown');
    assert.equal(check.evidence.boundary, reported);
    assert.equal(check.recoverable, false);
    assert.equal(report.repairs.some((repair) => repair.id.startsWith('promotion-journal-')), false);
    await assert.rejects(recoverInterruptedPromotion(paths), (error) => {
      assert.equal(error instanceof TypeError, false, 'a malformed journal must be refused, not crash');
      assert.match(error.message, entry.reason);
      return true;
    });
    assert.equal(await fs.access(file).then(() => true, () => false), true, 'a refusal must preserve the journal for inspection');
  });
}

test('a journal without the complete configured roots is refused by both, not crashed on', async (t) => {
  const { paths } = await fixture(t, 'missing-roots');
  const journal = baseJournal(paths, { records: [{ type: 'path', target: path.join(paths.pluginRoot, 'x') }] });
  const partial = { promotionStateDir: paths.promotionStateDir };
  await writeJournal(paths, journal);

  const reported = diagnosticBoundary(journal, partial);
  assert.match(reported, /complete configured target roots/);
  assert.equal(recoveryBoundary(journal, partial), reported);
  await assert.rejects(recoverInterruptedPromotion(partial), (error) => {
    assert.equal(error instanceof TypeError, false);
    assert.match(error.message, /complete configured target roots/);
    return true;
  });
});

test('the doctor reports a journal recovery would refuse as blocked, with the same reason', async (t) => {
  const home = await scratch(t, 'doctor-symlink');
  const paths = resolveEvolutionPaths({ dshHome: home });
  await fs.mkdir(paths.promotionStateDir, { recursive: true, mode: 0o700 });
  await writeJournal(paths, baseJournal(paths, { records: [{ type: 'symlink', target: path.join(paths.pluginRoot, 'link') }] }));

  const report = await collectDiagnostics({ dshHome: home, home: true, probe: { skipComposition: true } });
  const check = report.checks.find((candidate) => candidate.id === 'promotion.journal');
  assert.equal(check.level, 'blocked');
  assert.equal(check.evidence.state, 'state-unknown');
  const stored = JSON.parse(await fs.readFile(path.join(paths.promotionStateDir, 'journal.json'), 'utf8'));
  assert.equal(check.evidence.boundary, recoveryBoundary(stored, paths));
  assert.match(check.evidence.boundary, /unsupported shape/);
  assert.match(check.summary, /unsupported shape/, 'the summary must describe the real refusal');
  assert.equal(check.recoverable, false);
  assert.equal(report.repairs.some((repair) => repair.id === 'promotion-journal-recover'), false, 'no repair may be offered for a journal recovery refuses');
});
