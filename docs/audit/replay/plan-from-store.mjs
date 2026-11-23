#!/usr/bin/env node
/**
 * Replay the production discovery planner over a copy of a real experience store.
 *
 * The script never opens the source store: it copies the SQLite file into a
 * temporary directory first, then reads the same bounded knowledge rows
 * `evolution_plan` reads, projects the local failure memory if one is named, and
 * runs the same pure planner. It is read-only with respect to the data root,
 * starts no host, and writes nothing except the report you ask for.
 *
 * Usage:
 *   node docs/audit/replay/plan-from-store.mjs --store <experience.sqlite>
 *     [--memory <evolution-memory.json>]
 *     [--limit 5] [--min-occurrences 3] [--focus <text>]
 *     [--now <ISO>] [--versions <dsh,cordis,evolution>]
 *     [--module <experience-plan.js>] [--json]
 *
 * `--module` is what makes a before/after comparison possible: point it at the
 * planner from another revision, for example
 *
 *   git show origin/main:lib/experience-plan.js > /tmp/baseline-plan.js
 *   node docs/audit/replay/plan-from-store.mjs --store <copy> \
 *     --memory <evolution-memory.json> --module /tmp/baseline-plan.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function valueOf(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { limit: 5, minOccurrences: 3, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--store') { options.store = path.resolve(valueOf(argv, index, arg)); index += 1; }
    else if (arg === '--home') {
      const home = path.resolve(valueOf(argv, index, arg));
      options.store = path.join(home, 'storages', 'evolution-experience', 'experience.sqlite');
      const memory = path.join(home, 'storages', 'evolution', 'evolution-memory.json');
      if (!options.memory && fs.existsSync(memory)) options.memory = memory;
      index += 1;
    }
    else if (arg === '--memory') { options.memory = path.resolve(valueOf(argv, index, arg)); index += 1; }
    else if (arg === '--limit') { options.limit = Number(valueOf(argv, index, arg)); index += 1; }
    else if (arg === '--min-occurrences') { options.minOccurrences = Number(valueOf(argv, index, arg)); index += 1; }
    else if (arg === '--focus') { options.focus = valueOf(argv, index, arg); index += 1; }
    else if (arg === '--now') { options.now = valueOf(argv, index, arg); index += 1; }
    else if (arg === '--versions') { options.versions = valueOf(argv, index, arg); index += 1; }
    else if (arg === '--module') { options.module = path.resolve(valueOf(argv, index, arg)); index += 1; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export const HELP = `dsh-evolution plan replay

  node docs/audit/replay/plan-from-store.mjs --store <experience.sqlite> [options]

Options:
  --store <file>          experience.sqlite to copy and replay
  --home <dir>            DSH home; resolves the experience store and local failure memory
  --memory <file>         evolution-memory.json to project as failureMemory
  --limit <n>             candidate limit (default 5)
  --min-occurrences <n>   evidence floor (default 3)
  --focus <text>          planner focus filter
  --now <ISO>             clock the planner sees (default: now)
  --versions <a,b,c>      dsh,cordis,evolution applicability triple
  --module <file>         experience-plan.js to use (default: this tree)
  --json                  print the plan document instead of the summary
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.store) { console.log(HELP); return options.help ? 0 : 2; }
  const plannerPath = options.module ?? path.join(REPO_ROOT, 'lib', 'experience-plan.js');
  const recallPath = path.join(REPO_ROOT, 'lib', 'experience-recall.js');
  if (!fs.existsSync(plannerPath)) throw new Error(`no planner at ${plannerPath}`);
  const { planEvolutionCandidates } = await import(pathToFileURL(plannerPath).href);
  const { knowledgeExperienceRecord, failureMemoryExperienceRecord } = await import(pathToFileURL(recallPath).href);

  // Copy first: a read-only replay must not be able to lock or touch the source.
  // A live store is in WAL mode, so the snapshot is only complete with the
  // sidecar frames: without them a just-committed row would silently vanish.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-plan-replay-'));
  const copy = path.join(work, 'experience.sqlite');
  fs.copyFileSync(options.store, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(options.store + suffix)) fs.copyFileSync(options.store + suffix, copy + suffix);
  }
  const db = new (require('node:sqlite').DatabaseSync)(copy);
  const rows = db.prepare('SELECT key,body FROM knowledge ORDER BY revision DESC LIMIT 500').all().reverse();
  db.close();
  fs.rmSync(work, { recursive: true, force: true });

  const records = [];
  for (const row of rows) {
    let entry;
    try { entry = JSON.parse(row.body); } catch { continue; }
    const record = knowledgeExperienceRecord(entry, { maxText: 400, maxEvidenceRefs: 3 });
    if (record) records.push(record);
  }
  // The local durable failure memory is a second source in the same plan. It has
  // to be replayed too, because the two sources can name the same target and the
  // planner de-duplicates their occurrence totals; omitting it hides exactly the
  // cross-source attribution this replay is used to check.
  const failureMemory = [];
  if (options.memory) {
    const stored = JSON.parse(fs.readFileSync(options.memory, 'utf8'));
    if (!Array.isArray(stored?.entries)) throw new Error(`no entries array in ${options.memory}`);
    for (const entry of stored.entries) {
      const record = failureMemoryExperienceRecord(entry, { maxText: 400, maxEvidenceRefs: 3 });
      if (record) failureMemory.push(record);
    }
  }
  const versions = options.versions
    ? Object.fromEntries(['dsh', 'cordis', 'evolution'].map((key, index) => [key, options.versions.split(',')[index] ?? 'unknown']))
    : null;
  const plan = planEvolutionCandidates({ knowledge: records, failureMemory, versions }, {
    now: options.now ? Date.parse(options.now) : Date.now(),
    maxCandidates: options.limit,
    minOccurrences: options.minOccurrences,
    focus: options.focus,
  });
  if (options.json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  const summary = {
    planner: path.relative(REPO_ROOT, plannerPath) || plannerPath,
    store: options.store,
    memory: options.memory ? path.relative(REPO_ROOT, options.memory) || options.memory : null,
    knowledgeRows: records.length,
    memoryRows: failureMemory.length,
    candidates: plan.candidates.map((candidate) => ({
      problemKey: candidate.problemKey,
      score: candidate.score,
      occurrences: candidate.occurrences,
      volumeUnits: candidate.volumeUnits,
      observedFailureRate: candidate.observedFailureRate,
      rateBasis: candidate.rateBasis,
      attribution: candidate.attribution,
      origin: candidate.origin,
      failureModes: candidate.failureModes,
      originCounts: candidate.originCounts,
      loss: candidate.loss,
    })),
    none: plan.none,
    rejected: plan.rejected.map((entry) => ({
      problemKey: entry.problemKey, reason: entry.reason, occurrences: entry.occurrences, origins: entry.origins, detail: entry.detail,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
