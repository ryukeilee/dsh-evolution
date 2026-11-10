/**
 * Experience-driven discovery over *observed* history.
 *
 * The fixture is a bounded, redacted projection of what a real isolated host
 * acceptance run (DSH 0.2.2-rc.1, Cordis 4.1.0, Evolution 0.2.3) wrote into the
 * unified shared-experience store: repeated tool failures, recorded resolutions,
 * and structured experiment conclusions. It is not hand-authored behaviour: the
 * numbers, scopes, decisions and versions were read from the store after that
 * run (see `test/fixtures/experience-observed-0.2.2-rc.1.json`).
 *
 * The test replays those facts through the public store API into a fresh SQLite
 * store, then runs the same pure planner `evolution_plan` uses. It proves the
 * three properties the acceptance cases need: a recurring failure is found with
 * its evidence, an adopted problem is not proposed again, and a strategy already
 * proven ineffective under the same applicability is surfaced as such.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openSharedExperience, experienceEventId } from '../lib/shared-experience.js';
import { planEvolutionCandidates } from '../lib/experience-plan.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/experience-observed-0.2.2-rc.1.json', import.meta.url), 'utf8'));
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-observed-plan-'));
}

/** Replay the observed facts through the same public APIs the runtime uses. */
function replay() {
  const root = scratch();
  const store = openSharedExperience(root);
  let sequence = 0;
  const receipt = () => ({ sequence: (sequence += 1), writer: 'observed-fixture-writer' });
  // `recordFailure` has no timestamp parameter (the collector records the host
  // event when it happens), so failures land at replay time. Shift the recorded
  // conclusion timestamps forward by the same constant: their *relative* order
  // against the failures is the observed order, which is what the planner reads.
  const replayStart = Date.now();
  const shift = replayStart + 60_000 - Date.parse('2026-11-10T19:30:00.000Z');
  try {
    for (const failure of fixture.failures) {
      for (let index = 0; index < failure.occurrences; index += 1) {
        store.recordFailure({
          id: experienceEventId('observed-failure', failure.target, String(index)),
          type: 'tool/error',
          code: 'HOST_OPERATION_FAILED',
          target: failure.target,
        });
      }
    }
    for (const resolution of fixture.resolutions) {
      store.recordEvolution({
        eventType: 'promotion-succeeded',
        eventId: `observed-promotion:${resolution.target}`,
        target: resolution.target,
        audit: { at: resolution.lastSeen },
      }, 'observed-fixture', receipt());
    }
    fixture.conclusions.forEach((conclusion, index) => {
      store.recordConclusion({
        experimentId: `observed-conclusion-${index}`,
        target: conclusion.target,
        problem: conclusion.target,
        strategy: conclusion.approach,
        strategyFingerprint: conclusion.fingerprint,
        rootCause: conclusion.rootCause ?? "",
        failureMode: conclusion.failureMode ?? "",
        decision: conclusion.decision,
        applicability: fixture.host,
        occurredAt: new Date(Date.parse(conclusion.occurredAt) + shift).toISOString(),
      }, 'observed-fixture');
    });
    return { store, discovered: store.discover({ window: 500 }) };
  } catch (error) {
    store.close();
    throw error;
  }
}

function plan(discovered, versions = fixture.host) {
  return planEvolutionCandidates({
    knowledge: discovered.records,
    failureMemory: [],
    versions,
  }, { now: Date.now(), minOccurrences: 3, maxCandidates: 5 });
}

test('observed history: the recurring unexplained failure is selected with real evidence', () => {
  const { store, discovered } = replay();
  try {
    assert.ok(discovered.records.length >= 8, `expected the observed rows, got ${discovered.records.length}`);
    const planned = plan(discovered);
    assert.equal(planned.ok, true);
    assert.ok(planned.selected, 'a candidate must be selected from the observed failures');
    // The two unresolved targets that carry experiment verdicts are selected;
    // the adopted and resolved targets are rejected instead.
    assert.ok(['tool probe invalid fix', 'tool probe regression fix'].includes(planned.selected.problemKey),
      `unexpected selected target ${planned.selected.problemKey}`);
    assert.ok(planned.selected.occurrences >= 3);
    assert.ok(planned.selected.evidenceRefs.length > 0, 'the candidate cites recorded evidence');
    assert.equal(planned.selected.applicabilityVerified, true);
    assert.equal(planned.selected.applicability.dsh, '0.2.2-rc.1');
    assert.equal(planned.selected.applicability.cordis, '4.1.0');
    const noBenefit = planned.candidates.find((candidate) => candidate.problemKey === 'tool probe invalid fix');
    assert.ok(noBenefit, 'the no-benefit target stays a candidate until a new hypothesis is tried');
    assert.equal(noBenefit.provenIneffective.length, 1, 'the no-benefit verdict is attached to the candidate');
    assert.equal(noBenefit.provenIneffective[0].decision, 'no-benefit');
    assert.equal(noBenefit.provenIneffective[0].fingerprint, 'd387e503e0f6ebd2');
    assert.equal(noBenefit.requiresNewHypothesis, true);
    // A regression verdict is surfaced for the regression target as well.
    const regression = planned.candidates.find((candidate) => candidate.problemKey === 'tool probe regression fix');
    assert.ok(regression, 'the regression target stays a candidate until a new hypothesis is tried');
    assert.equal(regression.provenIneffective[0]?.decision, 'regression');
  } finally {
    store.close();
  }
});

test('observed history: an adopted problem is not proposed again', () => {
  const { store, discovered } = replay();
  try {
    const planned = plan(discovered);
    assert.equal(planned.candidates.some((candidate) => candidate.problemKey === 'tool probe healthcheck'), false);
    const rejected = planned.rejected.find((entry) => entry.problemKey === 'tool probe healthcheck');
    assert.ok(rejected, 'the adopted target must be reported, not silently dropped');
    assert.equal(rejected.reason, 'already-resolved');
  } finally {
    store.close();
  }
});

test('observed history: applicability is part of the conclusion, not a global fact', () => {
  const { store, discovered } = replay();
  try {
    // The same history read under a different Cordis version cannot claim the
    // recorded no-benefit/regression was proven for *these* conditions, so the
    // decision becomes inspectable prior evidence instead of a hard exclusion.
    const other = plan(discovered, { dsh: '0.2.2-rc.1', cordis: '4.0.5', evolution: '0.2.3' });
    for (const candidate of other.candidates) {
      assert.deepEqual(candidate.provenIneffective, [], `${candidate.problemKey} must not block under another version`);
      for (const attempt of candidate.priorAttempts) assert.equal(attempt.sameApplicability, false);
    }
    const healthcheck = other.candidates.find((candidate) => candidate.problemKey === 'tool probe healthcheck');
    assert.ok(healthcheck, 'a version change reopens the adopted target for a new experiment');
    assert.equal(healthcheck.requiresNewHypothesis, false);
  } finally {
    store.close();
  }
});

test('observed history: the plan is deterministic for the same stored facts', () => {
  const { store, discovered } = replay();
  try {
    assert.deepEqual(plan(discovered), plan(discovered));
  } finally {
    store.close();
  }
});
