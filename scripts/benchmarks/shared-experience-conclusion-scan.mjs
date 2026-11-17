#!/usr/bin/env node
// A/B of the scoped `findConclusions()` read on one identical store.
//
// The measured read is the proposal gate's long-term cost: it scans canonical
// knowledge bodies to answer "is this exact strategy already recorded as
// ineffective for this target under these versions". The pre-change read counted
// the scope's rows with one full-body `instr()` scan and then read the window
// with a second one. The current read reads the window first and only pays for
// the count when the window is full, which is the only case where the total can
// exceed what was returned.
//
// baseline and candidate below are the two query strategies executed over the
// same DatabaseSync connection, in alternating order. Every pair must return
// deep-equal output before its timings are recorded, and the production
// `store.findConclusions()` answer is compared against the pair once, so a
// faster-but-different query fails the run instead of being reported.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { openSharedExperience, experienceEventId, assertPrivateExperienceFile } from '../../lib/shared-experience.js';
import { normalizeKnowledgeEvent } from '../../lib/dockyard-domain/knowledge.js';
import { parseConclusionStrategy } from '../../lib/experience-plan.js';

const args = process.argv.slice(2);
const options = { rows: 10000, window: 500, rounds: 7, samples: 5, out: null, keep: false };
for (let i = 0; i < args.length; i += 1) {
  const name = args[i].slice(2);
  if (args[i] === '--keep') { options.keep = true; continue; }
  const value = args[i + 1];
  if (!args[i].startsWith('--') || !Object.hasOwn(options, name) || value === undefined) throw new Error('Unknown/missing option: ' + args[i]);
  i += 1;
  options[name] = name === 'out' ? value : Number(value);
}
for (const name of ['rows', 'window', 'rounds', 'samples']) {
  if (!Number.isSafeInteger(options[name]) || options[name] < 1) throw new Error('Invalid --' + name + ': expected integer >= 1');
}
const TARGET = 'tool:read_7';
const SCOPE = normalizeKnowledgeEvent({ problem: TARGET, capabilityId: TARGET }, { sourceCollection: 'learnings' })?.scope ?? null;
if (!SCOPE) throw new Error('target does not normalize to a scope');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-conclusion-scan-'));
const store = openSharedExperience(root);
for (let index = 0; index < options.rows; index += 1) {
  store.recordFailure({
    id: experienceEventId('conclusion-scan', index),
    type: 'tool/error',
    code: 'ENOENT',
    // One distinct canonical row per event, so the store's knowledge table (the
    // table this read scans) grows with --rows exactly as it would over time.
    target: 'tool:read_' + index,
  });
}
const file = path.join(root, 'experience.sqlite');
store.close();
assertPrivateExperienceFile(file);
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout=2000');

const DECISION_RANK = new Map([
  ['regression', 0], ['no-benefit', 1], ['reverted-unconfirmed', 2], ['adopted', 3], ['insufficient-evidence', 4],
]);
function compareMatches(left, right) {
  const same = Number(Boolean(right.sameApplicability)) - Number(Boolean(left.sameApplicability));
  if (same !== 0) return same;
  const rank = (DECISION_RANK.get(left.decision) ?? 9) - (DECISION_RANK.get(right.decision) ?? 9);
  if (rank !== 0) return rank;
  const recency = Date.parse(String(right.lastSeen ?? '')) - Date.parse(String(left.lastSeen ?? ''));
  if (Number.isFinite(recency) && recency !== 0) return recency;
  return left.knowledgeKey < right.knowledgeKey ? -1 : left.knowledgeKey > right.knowledgeKey ? 1 : 0;
}
// Frozen projection of one canonical row, copied from the pre-change
// `findConclusions()` body so both strategies are judged on the same work.
function project(rows, scope) {
  const matches = [];
  for (const row of rows) {
    let entry;
    try { entry = JSON.parse(row.body); } catch { continue; }
    if (!entry || entry.scope !== scope) continue;
    const conclusion = parseConclusionStrategy(entry.strategy);
    if (!conclusion) continue;
    matches.push({
      knowledgeKey: typeof entry.knowledgeKey === 'string' ? entry.knowledgeKey : row.key,
      decision: typeof entry.lastStatus === 'string' ? entry.lastStatus : '',
      outcome: typeof entry.lastOutcome === 'string' ? entry.lastOutcome : '',
      state: typeof entry.state === 'string' ? entry.state : '',
      regressionCount: Number.isFinite(Number(entry.regressionCount)) ? Number(entry.regressionCount) : 0,
      count: Number.isFinite(Number(entry.occurrenceCount ?? entry.count)) ? Number(entry.occurrenceCount ?? entry.count) : 0,
      applicability: { dsh: conclusion.dsh, cordis: conclusion.cordis, evolution: conclusion.evolution },
      sameApplicability: false,
      lastSeen: typeof entry.lastSeen === 'string' ? entry.lastSeen : null,
    });
  }
  matches.sort(compareMatches);
  return matches;
}
const marker = '\"scope\":' + JSON.stringify(SCOPE);

function baselineRead() {
  db.exec('BEGIN');
  try {
    const scanned = db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
    const scoped = db.prepare('SELECT count(*) AS n FROM knowledge WHERE instr(body, ?) > 0').get(marker).n;
    const rows = db.prepare('SELECT key,body FROM knowledge WHERE instr(body, ?) > 0 ORDER BY revision DESC LIMIT ?')
      .all(marker, options.window).reverse();
    const matches = project(rows, SCOPE);
    db.exec('COMMIT');
    return { scanned: scanned, considered: rows.length, truncated: scoped > rows.length, matches: matches };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function candidateRead() {
  db.exec('BEGIN');
  try {
    const scanned = db.prepare('SELECT count(*) AS n FROM knowledge').get().n;
    const rows = db.prepare('SELECT key,body FROM knowledge WHERE instr(body, ?) > 0 ORDER BY revision DESC LIMIT ?')
      .all(marker, options.window);
    const scoped = rows.length < options.window
      ? rows.length
      : db.prepare('SELECT count(*) AS n FROM knowledge WHERE instr(body, ?) > 0').get(marker).n;
    rows.reverse();
    const matches = project(rows, SCOPE);
    db.exec('COMMIT');
    return { scanned: scanned, considered: rows.length, truncated: scoped > rows.length, matches: matches };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function time(read) {
  const started = performance.now();
  const value = read();
  return { ms: performance.now() - started, value: value };
}

const samples = [];
let lastPair = null;
for (let round = 0; round < options.rounds; round += 1) {
  const order = round % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
  const pair = {};
  for (const side of order) {
    let total = 0;
    let last = null;
    for (let sample = 0; sample < options.samples; sample += 1) {
      const result = time(side === 'baseline' ? baselineRead : candidateRead);
      total += result.ms;
      last = result.value;
    }
    pair[side] = { ms: total / options.samples, value: last };
  }
  assert.deepEqual(pair.candidate.value, pair.baseline.value, 'round ' + round + ': the two scoped reads disagree');
  lastPair = pair.baseline.value;
  samples.push({ round: round, order: order.join(','), baselineMs: pair.baseline.ms, candidateMs: pair.candidate.ms });
}
const production = storeProbe();
function storeProbe() {
  // One production answer, re-opened read-only through the real store API, must
  // match the pair's result exactly.
  const reopened = openSharedExperience(root);
  try {
    const value = reopened.findConclusions({ target: TARGET, window: options.window });
    assert.deepEqual(
      { scanned: value.scanned, considered: value.considered, truncated: value.truncated, matches: value.matches },
      baselineRead(),
      'the production scoped read disagrees with the frozen baseline read',
    );
    delete value.source;
    delete value.best;
    return value;
  } finally { reopened.close(); }
}
db.close();
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const summary = {
  rows: options.rows,
  window: options.window,
  scopeRows: lastPair.considered,
  baselineMedianMs: median(samples.map((sample) => sample.baselineMs)),
  candidateMedianMs: median(samples.map((sample) => sample.candidateMs)),
  changePercent: 0,
};
summary.changePercent = (summary.candidateMedianMs - summary.baselineMedianMs) / summary.baselineMedianMs * 100;
const result = {
  node: process.version,
  platform: process.platform + '-' + process.arch,
  method: 'Identical store file, one DatabaseSync connection, alternating baseline/candidate order, '
    + options.samples + ' timed samples per side per round, deep-equal output asserted per round. '
    + 'Baseline is the pre-change unconditional scoped count; candidate reads the window first and counts only when full.',
  options: options,
  samples: samples,
  summary: summary,
  production: { considered: production.considered, truncated: production.truncated, matches: production.matches.length },
};
if (options.out) {
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ summary: summary, production: result.production }, null, 2));
if (!options.keep) fs.rmSync(root, { recursive: true, force: true });
