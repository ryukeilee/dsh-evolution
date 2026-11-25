#!/usr/bin/env node
/**
 * Deterministic fixture proof for the unread-session retry admission path.
 *
 * This is NOT a real-round validation: the pilot's decisions are scripted below,
 * no model is called, and the only real work is the host executing the read /
 * grep tool calls. It proves the producer's attempt log, voiding and admission
 * bookkeeping against a real isolated ACP host and real host tools.
 *
 * The pilot-isolation preflight is stubbed through the existing
 * `preflightRunner` seam, so this script does NOT prove pilot isolation. The
 * production preflight and the real-model paired runs are covered elsewhere.
 *
 * Usage:
 *   node scripts/acceptance/task-benefit-session-retry-check.mjs
 *     [--cli <dsh>] [--binary <desktop>] [--keep]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { produceTaskBenefit, safeErrorCode } from './task-benefit.mjs';
import { mintTaskId } from '../../lib/desktop-task-protocol.js';
import { validateTaskBenefit } from '../../lib/orchestrator.js';

const DEFAULT_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const DEFAULT_BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const argv = process.argv.slice(2);
let cli = DEFAULT_CLI;
let binary = DEFAULT_BINARY;
let keep = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--cli' && argv[index + 1]) cli = path.resolve(argv[++index]);
  else if (arg === '--binary' && argv[index + 1]) binary = path.resolve(argv[++index]);
  else if (arg === '--keep') keep = true;
  else {
    process.stderr.write('Unknown or incomplete argument: ' + arg.slice(0, 120) + '\n');
    process.exit(1);
  }
}

async function assertExecutable(file, label) {
  try {
    await fs.access(file, constants.X_OK);
  } catch {
    process.stderr.write(label + ' is missing or not executable: ' + file + '\n');
    process.exit(1);
  }
}
await assertExecutable(cli, '--cli');
await assertExecutable(binary, '--binary');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidateHost = await fs.readFile(path.join(repo, 'scripts/acceptance/fixtures/complete-read-line.host'), 'utf8');

// ACP renders read results with the canonical /private/var/... form of the
// temporary root. Canonicalize the mkdtemp home before any read path is built,
// or task.reads will not match the host's rendered path and attribution fails.
const rawHome = await fs.mkdtemp(path.join(os.tmpdir(), 'task-benefit-retry-check-'));
const home = await fs.realpath(rawHome);

const files = [];
const sentinels = [];
for (const name of ['a', 'b', 'c']) {
  const sentinel = 'sentinel-' + name + '-' + crypto.randomBytes(6).toString('hex');
  const line = JSON.stringify({
    name: 'generated-config-' + name,
    routes: Array.from({ length: 80 }, (_, index) => ({ path: '/feature/' + index, enabled: index % 2 === 0 })),
    sentinel,
  });
  await fs.writeFile(path.join(home, name + '.json'), line, { mode: 0o600 });
  files.push({ name: name + '.json', path: path.join(home, name + '.json'), sentinel });
  sentinels.push(sentinel);
}
const task = {
  id: 'read-three-long-lines',
  prompt: '请依次用 read 工具读取 a.json、b.json、c.json 的第一行，然后告诉我这三个文件各自的 sentinel 字段值。',
  expect: JSON.stringify(sentinels),
  reads: files.map((file) => ({ path: file.path, token: file.sentinel })),
};

const preflightRunner = async () => ({
  ok: true,
  ownToolCalls: 0,
  ownToolNames: [],
  text: 'DSH_PILOT_NO_TOOLS',
  usage: { input: 1, output: 1 },
  wallMs: 1,
});

const reply = (decision) => ({
  ok: true,
  text: JSON.stringify(decision),
  usage: { input: 10, output: 5, cache: { read: 0 } },
  wallMs: 1,
  ownToolCalls: 0,
  ownToolNames: [],
});
const readAt = (index) => reply({ tool: 'read', arguments: { file_path: files[index].path } });
const recoveryGrep = () => reply({ tool: 'grep', arguments: { pattern: 'sentinel', path: files[0].path } });
const stopComplete = () => reply({ stop: true, message: sentinels.join(', ') });
const stopUnread = () => reply({ stop: true, message: 'I did not read the files.' });
const stopPartial = () => reply({ stop: true, message: sentinels.slice(0, 2).join(', ') });

/**
 * One side script: three start reads, then the candidate stops while the
 * baseline spends one recovery turn on grep (an observed recovery tool), then
 * stops. The baseline's extra turn is what makes candidate turns smaller.
 */
function scriptedRun(label, results, { partial = false } = {}) {
  const baseline = label.startsWith('baseline-');
  if (!baseline) return results >= 3 ? stopComplete() : readAt(results);
  if (results >= 4) return partial ? stopPartial() : stopComplete();
  if (results === 3) return recoveryGrep();
  return readAt(results);
}

function pilotRunnerFor({ unreadLabel = null, partialLabel = null } = {}) {
  return async (prompt, options) => {
    const label = path.basename(typeof options?.cwd === 'string' ? options.cwd : '');
    const results = (String(prompt).match(/\[tool result/g) ?? []).length;
    if (label === unreadLabel && results === 0) return stopUnread();
    return scriptedRun(label, results, { partial: label === partialLabel });
  };
}

function newSummary(scenario, description) {
  return {
    scenario,
    description,
    taskId: null,
    reportOk: false,
    artifactComplete: false,
    admission: null,
    attempts: null,
    validator: null,
    assertions: [],
    ok: false,
    error: null,
  };
}
function check(summary, name, condition) {
  summary.assertions.push({ name, ok: condition === true });
  return condition === true;
}
function attemptsFor(report, side, repetition) {
  return (Array.isArray(report?.attempts) ? report.attempts : [])
    .filter((entry) => entry.side === side && entry.repetition === repetition);
}
function perSessionFor(artifact, side, repetition) {
  return (artifact?.attempts?.perSession ?? [])
    .find((entry) => entry.side === side && entry.repetition === repetition) ?? null;
}
function unreadEquals(unread, candidate, baseline) {
  return unread?.candidate === candidate && unread?.baseline === baseline;
}
function attemptCounts(report, artifact) {
  const attempts = Array.isArray(report?.attempts) ? report.attempts : [];
  return {
    total: attempts.length,
    voided: attempts.filter((entry) => entry.voided === true).length,
    baseline1: attemptsFor(report, 'baseline', 1).length,
    candidate1: attemptsFor(report, 'candidate', 1).length,
    perSession: artifact?.attempts?.perSession?.length ?? 0,
    artifactVoided: artifact?.attempts?.voided?.length ?? 0,
  };
}

async function runScenario({ scenario, description, name, unreadLabel, partialLabel }) {
  const summary = newSummary(scenario, description);
  const taskId = mintTaskId();
  summary.taskId = taskId;
  const work = path.join(home, 'work-' + name);
  const artifactFile = path.join(home, 'storages', 'evolution', 'desktop-tasks', 'task-evidence', taskId + '.json');
  try {
    const result = await produceTaskBenefit({
      home,
      work,
      taskId,
      task,
      candidateHost,
      improvement: 'context-policy',
      runs: 3,
      serial: true,
      model: 'scripted-pilot',
      binary,
      cli,
      preflightRunner,
      pilotRunner: pilotRunnerFor({ unreadLabel, partialLabel }),
    });
    const { report, artifact } = result;
    summary.reportOk = report.ok === true;
    summary.artifactComplete = artifact.complete === true;
    summary.admission = {
      ok: report.admission?.ok === true,
      code: report.admission?.code ?? null,
      reason: report.admission?.reason ?? null,
      unread: report.admission?.unread ?? null,
    };
    summary.attempts = attemptCounts(report, artifact);
    if (scenario === 'A') {
      const baselineAttempts = attemptsFor(report, 'baseline', 1);
      const first = baselineAttempts[0] ?? {};
      const second = baselineAttempts[1] ?? {};
      const session = perSessionFor(artifact, 'baseline', 1);
      check(summary, 'report.ok', report.ok === true);
      check(summary, 'artifact.complete', artifact.complete === true);
      check(summary, 'admission.ok', report.admission?.ok === true);
      check(summary, 'admission.unread', unreadEquals(report.admission?.unread, 0, 1));
      check(summary, 'baseline-1 attempts=2', baselineAttempts.length === 2);
      check(summary, 'baseline-1 first voided', first.voided === true && first.voidReason === 'answered-without-task-reads' && first.turns === 1 && first.toolCalls === 0);
      check(summary, 'baseline-1 retry retained', second.voided === false);
      check(summary, 'artifact perSession baseline-1 attempts=2', session?.attempts?.length === 2);
      check(summary, 'artifact voided records baseline-1', (artifact.attempts?.voided ?? []).some((row) => row.side === 'baseline' && row.repetition === 1 && row.attempt === 1 && row.voidReason === 'answered-without-task-reads'));
      const verdict = validateTaskBenefit(artifact, {
        hostSha256: artifact.candidateHostSha256,
        taskId,
        improvement: 'context-policy',
        applicability: artifact.host,
      });
      summary.validator = { ok: verdict.ok === true, benefit: verdict.benefit === true };
      check(summary, 'validateTaskBenefit.ok', verdict.ok === true);
      check(summary, 'validateTaskBenefit.benefit', verdict.benefit === true);
    } else if (scenario === 'B') {
      const baselineAttempts = attemptsFor(report, 'baseline', 1);
      check(summary, 'report.ok=false', report.ok === false);
      check(summary, 'admission.ok=false', report.admission?.ok === false);
      check(summary, 'admission.code', report.admission?.code === 'E_ACCEPTANCE_SESSION_NOT_COMPLIANT');
      check(summary, 'baseline-1 attempts=1', baselineAttempts.length === 1);
      check(summary, 'no voided attempts', summary.attempts.voided === 0 && summary.attempts.artifactVoided === 0);
      check(summary, 'artifact.complete=false', artifact.complete === false);
    } else {
      const candidateAttempts = attemptsFor(report, 'candidate', 1);
      const retained = candidateAttempts.find((entry) => entry.voided === false) ?? {};
      check(summary, 'candidate-1 attempts=2', candidateAttempts.length === 2);
      check(summary, 'candidate-1 retained correct', retained.correct === true && retained.taskReadsComplete === true);
      check(summary, 'admission.ok=false', report.admission?.ok === false);
      check(summary, 'admission.code', report.admission?.code === 'E_ACCEPTANCE_CANDIDATE_UNREAD_ANSWER');
      check(summary, 'admission.unread', unreadEquals(report.admission?.unread, 1, 0));
      check(summary, 'artifact.complete=false', artifact.complete === false);
    }
  } catch (error) {
    summary.error = {
      code: safeErrorCode(error),
      message: String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 240),
    };
  } finally {
    if (!keep) {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
      await fs.rm(artifactFile, { force: true }).catch(() => {});
    }
  }
  summary.ok = summary.error === null && summary.assertions.length > 0 && summary.assertions.every((row) => row.ok);
  return summary;
}

const summaries = [];
summaries.push(await runScenario({
  scenario: 'A',
  description: 'baseline-1 unread first attempt is voided and the rerun is admitted',
  name: 'a',
  unreadLabel: 'baseline-1',
}));
summaries.push(await runScenario({
  scenario: 'B',
  description: 'baseline-1 reads but answers wrong; no retry, run rejected',
  name: 'b',
  partialLabel: 'baseline-1',
}));
summaries.push(await runScenario({
  scenario: 'C',
  description: 'candidate-1 unread first attempt is voided; candidate-only unread fails closed',
  name: 'c',
  unreadLabel: 'candidate-1',
}));

if (!keep) await fs.rm(rawHome, { recursive: true, force: true }).catch(() => {});
else {
  process.stdout.write('Kept home: ' + home + '\n');
  for (const name of ['a', 'b', 'c']) process.stdout.write('Kept work: ' + path.join(home, 'work-' + name) + '\n');
}
process.stdout.write(JSON.stringify({ kind: 'task-benefit-session-retry-check', ok: summaries.every((row) => row.ok), scenarios: summaries }, null, 2) + '\n');
process.exitCode = summaries.every((row) => row.ok) ? 0 : 1;
