import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDiagnostics, resolveEvolutionPaths, inspectJsonLines } from '../lib/diagnostics.js';
import { collectDiagnostics as baseline, inspectJsonLines as oldInspect } from './fixtures/diagnostics.mjs';

const normalize = (report) => { delete report.generatedAt; return report; };

/**
 * Which check ids may legitimately differ from the frozen baseline, and why.
 *
 * `state.ownership` is a genuinely new check. `data.key` predates this change
 * but used to be emitted only for an unusable key, so its presence on a healthy
 * fixture is an addition this baseline cannot list - it is named here so any
 * *unnamed* new check still fails the comparison.
 */
const ADDED_CHECK_IDS = new Set(['state.ownership', 'state.retention-floor']);
const ADDITIONAL_CHECK_IDS = new Set(['data.key']);

/**
 * Fields this change deliberately changed or removed from an existing check.
 * Both are named and asserted separately below, never dropped wholesale:
 *
 * - `data.root` no longer carries a `key` verdict or key advice (data.key owns
 *   the key decision);
 * - the archive lock evidence now comes from the runtime's own classifier
 *   (lib/domain-storage.js `inspectArchiveLock`), a shape this baseline predates.
 */
const withoutDeliberateReportChanges = (check) => {
  if (check.id === 'data.root') {
    const { key, archiveLock, staleLock, lockProblems, lockAdvisory, ...evidence } = check.evidence ?? {};
    return { ...check, evidence };
  }
  if (check.id === 'state.domain') {
    const { archiveLock, staleLock, lockProblems, lockAdvisory, ...evidence } = check.evidence ?? {};
    return { ...check, evidence };
  }
  if (check.id === 'state.archives' && check.evidence?.dockyard) {
    // The shared archive classifier changes the remediation contract: the new
    // advice preserves originals and blocks index-only rebuilding when bytes or
    // a transition are unproven. The assertion below checks that advice directly.
    const { archiveIntegrity, sealTemporaries, ...dockyard } = check.evidence.dockyard;
    const { remediation, ...report } = check;
    return { ...report, evidence: { ...check.evidence, dockyard } };
  }
  return check;
};

/** The derived report fields must describe the check list they ship with. */
function assertSelfConsistent(report) {
  const counts = { ok: 0, degraded: 0, blocked: 0, notEvaluated: 0 };
  for (const check of report.checks) {
    if (check.level === 'ok') counts.ok += 1;
    else if (check.level === 'degraded') counts.degraded += 1;
    else if (check.level === 'blocked') counts.blocked += 1;
    else counts.notEvaluated += 1;
  }
  assert.deepEqual(report.summary, counts, `${report.mode}: summary must count the shipped checks`);
  assert.equal(report.partial, counts.notEvaluated > 0, `${report.mode}: partial must follow the not-evaluated count`);
  assert.equal(report.status, counts.blocked > 0 ? 'blocked' : counts.degraded > 0 ? 'degraded' : 'healthy');
  assert.deepEqual(report.coverage.evaluated, report.checks.filter((check) => check.level !== 'not-evaluated').map((check) => check.id));
  const notEvaluated = report.checks.filter((check) => check.level === 'not-evaluated');
  assert.deepEqual(report.coverage.notEvaluated.map((entry) => entry.id), notEvaluated.map((check) => check.id));
  for (const entry of report.coverage.notEvaluated) {
    const check = notEvaluated.find((candidate) => candidate.id === entry.id);
    assert.equal(entry.reason, check.evidence.reason || 'not observable in this mode');
  }
}

function assertMatchesBaseline(currentReport, frozenReport) {
  const current = normalize(currentReport);
  const frozen = normalize(frozenReport);
  // Only the check list and the counts derived from it may differ from the
  // frozen report; every other top-level field must still match.
  const { checks, summary, coverage, ...currentRest } = current;
  const { checks: frozenChecks, summary: frozenSummary, coverage: frozenCoverage, ...frozenRest } = frozen;
  assert.deepEqual(currentRest, frozenRest, 'report fields drifted from the frozen baseline');
  assertSelfConsistent(current);
  assertSelfConsistent(frozen);

  // Drop only the genuinely new check, then compare by id: every baseline check
  // must still exist and be identical (apart from the two named fields), and a
  // check the baseline does not list must be a named addition.
  const comparable = checks.filter((check) => !ADDED_CHECK_IDS.has(check.id));
  const currentById = new Map(comparable.map((check) => [check.id, check]));
  for (const check of frozenChecks) {
    assert.ok(currentById.has(check.id), `check ${check.id} disappeared`);
    assert.deepEqual(
      withoutDeliberateReportChanges(currentById.get(check.id)),
      withoutDeliberateReportChanges(check),
      `check ${check.id} drifted from the frozen baseline`,
    );
  }
  for (const check of comparable) {
    if (frozenChecks.some((entry) => entry.id === check.id)) continue;
    assert.ok(ADDITIONAL_CHECK_IDS.has(check.id), `check ${check.id} is neither in the baseline nor a named addition`);
  }

  // The excluded fields are still produced (or deliberately gone).
  const root = current.checks.find((check) => check.id === 'data.root');
  assert.equal(root.evidence.archiveLock.kind, 'absent', 'the runtime archive-lock classifier is reported');
  assert.equal(Object.hasOwn(root.evidence, 'key'), false, 'data.root does not speak about the key');
  const domain = current.checks.find((check) => check.id === 'state.domain');
  assert.deepEqual(domain.evidence.lockProblems, [], 'the absent-aggregate lock verdict is reported');
  const archives = current.checks.find((check) => check.id === 'state.archives');
  assert.deepEqual(archives.evidence.dockyard.sealTemporaries, [], 'no seal remnants in the baseline fixtures');
  assert.equal(archives.evidence.dockyard.archiveIntegrity.valid, true, 'the shared read-only archive classifier is reported');
  if (archives.level === 'degraded') assert.match(archives.remediation, /Resolve any pending install or compaction transition first/);
  assert.ok(current.checks.some((check) => check.id === 'state.ownership'), 'the new ownership check is present');
}

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
        assertMatchesBaseline(await collectDiagnostics(options), await baseline(options));
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
