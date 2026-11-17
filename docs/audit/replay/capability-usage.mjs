#!/usr/bin/env node
/**
 * Read-only evidence: derive the `usage` projection that
 * `readPublishedPluginReview({ usage })` accepts, from the persisted DSH session
 * logs.
 *
 * The review deliberately takes usage as an *input*: the runtime never scans
 * session logs, and this script is the operator-run way to produce that input.
 * It reads `session.v4.jsonl.zstd` files, counts calls by tool name and never
 * prints transcript text, arguments or results.
 *
 * Classification rule (reproducible, conservative):
 *   - a call to a published tool counts as `verificationInvocations` when the
 *     same session also called one of the promotion-lifecycle tools
 *     (`evolution_probe`, `evolution_trial`, `evolution_measure`,
 *     `evolution_promote`, `evolution_canary_observe`, `evolution_desktop`);
 *   - every other call counts as `workflowInvocations` — a real session that
 *     simply used the capability;
 *   - `capabilityAssessment` is never inferred. Pass `--assessments <file>`
 *     with an explicit `{ "<recordId>": "self-contained" | "workflow-relevant" }`
 *     map after reviewing the source; otherwise every record stays `unknown`,
 *     which cannot trigger a retirement recommendation.
 *
 * Incompleteness is never rounded down to zero. If any session log cannot be
 * read, decompressed or parsed, or a published plugin's own source cannot be
 * read, the affected counts are emitted as `null` and the projection says
 * `complete: false` with the failures. A `null` count is "unknown" to the
 * review, so an incomplete scan cannot produce a disable recommendation.
 *
 * Usage:
 *   node docs/audit/replay/capability-usage.mjs [--home <DSH_HOME>] [--out <file>]
 *     [--assessments <file>]
 *
 * Exits 3 when the scan is incomplete (the projection is still printed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PROMOTION_LIFECYCLE = new Set([
  'evolution_probe', 'evolution_trial', 'evolution_measure', 'evolution_promote',
  'evolution_canary_observe', 'evolution_desktop',
]);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const home = path.resolve(argValue('--home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
const sessionsRoot = path.join(home, 'sessions');
const dataRoot = path.join(home, 'storages', 'evolution');

const failures = {
  publicationIndexUnreadable: false,
  unreadableDirectories: 0,
  unreadableSessions: 0,
  undecompressableSessions: 0,
  invalidLogLines: 0,
  unreadableSources: [],
};

function publishedTools() {
  const file = path.join(dataRoot, 'shared-plugins', 'published.json');
  let index;
  try { index = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    failures.publicationIndexUnreadable = true;
    return [];
  }
  return (Array.isArray(index?.plugins) ? index.plugins : []).map((row) => ({
    id: typeof row?.id === 'string' ? row.id : null,
    pluginName: typeof row?.pluginName === 'string' ? row.pluginName : null,
    moduleUrl: typeof row?.moduleUrl === 'string' ? row.moduleUrl : null,
  })).filter((row) => row.id !== null);
}

/** The tool names a published plugin registers, read from its own source. */
function registeredToolNames(record) {
  if (typeof record.moduleUrl !== 'string') return { names: [], readable: false };
  let source;
  try { source = fs.readFileSync(new URL(record.moduleUrl), 'utf8'); } catch {
    return { names: [], readable: false };
  }
  const names = new Set();
  // The generated plugin keeps its tool definition inside a `Function(...)`
  // body string, so the quotes are often escaped in the file.
  const pattern = /name\s*:\s*\\?['"]([A-Za-z_$][\w$]*)\\?['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[1].startsWith('dsh-') && !match[1].startsWith('harness')) names.add(match[1]);
  }
  return { names: [...names], readable: names.size > 0 };
}

function sessionFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
      failures.unreadableDirectories += 1;
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'session.v4.jsonl.zstd') files.push(full);
    }
  };
  walk(root);
  return files;
}

const records = publishedTools();
const toolToRecord = new Map();
const unreadableRecordIds = new Set();
for (const record of records) {
  const { names, readable } = registeredToolNames(record);
  if (!readable) {
    unreadableRecordIds.add(record.id);
    failures.unreadableSources.push(record.id);
  }
  for (const name of names) toolToRecord.set(name, record);
}

const counts = new Map(records.map((record) => [record.id, { workflowInvocations: 0, verificationInvocations: 0 }]));
let scannedSessions = 0;
let scannedCalls = 0;
for (const file of sessionFiles(sessionsRoot)) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { failures.unreadableSessions += 1; continue; }
  let text;
  try { text = zlib.zstdDecompressSync(bytes).toString('utf8'); } catch { failures.undecompressableSessions += 1; continue; }
  scannedSessions += 1;
  const calls = [];
  let lifecycle = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { failures.invalidLogLines += 1; continue; }
    if (row?.type !== 'tool/call') continue;
    const name = row?.data?.name;
    if (typeof name !== 'string') continue;
    scannedCalls += 1;
    if (PROMOTION_LIFECYCLE.has(name)) lifecycle = true;
    if (toolToRecord.has(name)) calls.push(name);
  }
  for (const name of calls) {
    const record = toolToRecord.get(name);
    const bucket = counts.get(record.id);
    if (!bucket) continue;
    if (lifecycle) bucket.verificationInvocations += 1;
    else bucket.workflowInvocations += 1;
  }
}

let assessments = {};
const assessmentsFile = argValue('--assessments');
if (assessmentsFile) assessments = JSON.parse(fs.readFileSync(path.resolve(assessmentsFile), 'utf8'));

// A session-level failure means the whole scan is partial (a missing call could
// belong to any record); an unreadable plugin source only invalidates its own
// record, because we cannot know which tool names it registered.
const scanIncomplete = failures.publicationIndexUnreadable
  || failures.unreadableDirectories > 0
  || failures.unreadableSessions > 0
  || failures.undecompressableSessions > 0
  || failures.invalidLogLines > 0;
const incomplete = scanIncomplete || failures.unreadableSources.length > 0;

const projection = {
  source: 'session-evidence',
  complete: !incomplete,
  capturedAt: new Date().toISOString(),
  sessionsRoot,
  scannedSessions,
  scannedToolCalls: scannedCalls,
  rule: 'calls in a session that also called a promotion-lifecycle tool are verification traffic, not usage',
  ...(incomplete ? {
    failures,
    incompleteReason: 'the scan could not cover every session log or plugin source, so the counts below are unknown rather than zero',
  } : {}),
  records: Object.fromEntries([...counts].map(([id, value]) => [id, {
    workflowInvocations: scanIncomplete || unreadableRecordIds.has(id) ? null : value.workflowInvocations,
    verificationInvocations: scanIncomplete || unreadableRecordIds.has(id) ? null : value.verificationInvocations,
    capabilityAssessment: assessments[id] ?? 'unknown',
  }])),
};

const out = argValue('--out');
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify(projection, null, 2));
if (incomplete) process.exitCode = 3;
