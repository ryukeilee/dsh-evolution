#!/usr/bin/env node
/**
 * Read-only evidence: derive the `usage` projection that the read-only
 * self-evolution review consumes.
 *
 * The scanner itself lives in `lib/capability-usage.js` so the scan rules, the
 * persisted projection and the runtime reader are one implementation (they
 * used to be two: this script's counting rule and the review's expectations had
 * no shared contract).
 *
 * Classification rule (reproducible, conservative):
 *   - a published-tool call is `verificationInvocations` only while a
 *     promotion-lifecycle call (`evolution_probe` / `evolution_trial` /
 *     `evolution_measure` / `evolution_promote` / `evolution_canary_observe`)
 *     is open in the same session — i.e. the call sits inside the official
 *     pipeline that runs the candidate. `evolution_desktop` is not one: its
 *     audit/status/confirm actions are read-only and delegate only forwards,
 *     while the candidate runs in the Desktop session with its own lifecycle
 *     calls;
 *   - the official PTC (`run_code`) route is also read: its nested
 *     `tool/ptc-dispatch` rows are counted once (never together with the
 *     matching `tool/ptc-dispatch-start`). A dispatch whose parent is a single
 *     open native `run_code` instance is `workflowInvocations`; a historical
 *     non-`run_code` parent, a finished or reused run_code id, a PTC lifecycle
 *     window whose final row can arrive asynchronously after a later normal
 *     call, and a start with no final dispatch are `unattributedInvocations`;
 *   - every other native call is `workflowInvocations`: a real session that
 *     chose the capability;
 *   - a call made under a lifecycle call that never returned (crashed or
 *     truncated log) is `unattributedInvocations`; it is neither usage nor
 *     verification, and it stops "zero" from supporting a retirement
 *     recommendation;
 *   - both current-generation encodings are scanned (`session.v4.jsonl.zstd`
 *     and plaintext `session.v4.jsonl`). A directory holding both is an
 *     ambiguous encoding and neither is counted. Any other canonical session
 *     log (`session.jsonl`, `session.vN.jsonl[.zstd]`) in a directory without a
 *     current file is reported as unscanned and makes the projection incomplete
 *     rather than a measured zero; older generations beside a current file are
 *     the same session's migrated copies;
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
 *   node docs/audit/replay/capability-usage.mjs [--home <DSH_HOME>] [--data-root <dir>]
 *     [--out <file>] [--write] [--assessments <file>] [--template <file>]
 *
 * `--data-root` overrides the derived `<DSH_HOME>/storages/evolution`, so the
 * doctor/review supplement can write to the exact root it inspected. Session
 * evidence still comes from `<DSH_HOME>/sessions`.
 *
 * `--write` persists the projection at `<dataRoot>/shared-plugins/usage.json`,
 * which is the only place the explicit `evolution_plan` / `evolution_desktop
 * audit` reads. The persisted file is a counts table (record id, counts, tool
 * assessment); it never contains transcript text, tool arguments or results.
 *
 * `--template <file>` writes a read-only assessments template: every published
 * record with its registered tool names, source path and current counts, and
 * an `assessments` map whose values all start at "unknown". It never writes
 * `usage.json`. Passing the unedited template back through `--assessments` is
 * equivalent to passing no file: every capabilityAssessment stays "unknown"
 * and no retirement recommendation can follow. `--template` and `--write` are
 * mutually exclusive.
 *
 * Exits 3 when the scan is incomplete (the projection / template is still printed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assessmentsFromDocument,
  buildAssessmentsTemplate,
  summarizeCapabilityUsage,
  writeUsageProjection,
} from '../../../lib/capability-usage.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const home = path.resolve(argValue('--home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
const dataRootArg = argValue('--data-root');
const dataRoot = dataRootArg ? path.resolve(dataRootArg) : path.join(home, 'storages', 'evolution');

const templateFile = argValue('--template');
if (templateFile && process.argv.includes('--write')) {
  throw new Error('--template cannot be combined with --write');
}

let assessments = {};
const assessmentsFile = argValue('--assessments');
if (assessmentsFile) {
  assessments = assessmentsFromDocument(JSON.parse(fs.readFileSync(path.resolve(assessmentsFile), 'utf8')));
}

const metadata = {};
const projection = await summarizeCapabilityUsage({
  dataRoot,
  sessionsRoot: path.join(home, 'sessions'),
  // A template is generated blank regardless of any input file: it is the
  // starting point for the owner's review, never a place to infer a verdict.
  assessments: templateFile ? {} : assessments,
  metadata,
});

if (templateFile) {
  const template = buildAssessmentsTemplate({ projection, records: metadata.records });
  const target = path.resolve(templateFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600 });
  console.error(`assessments template written to ${target}`);
  console.log(JSON.stringify(template, null, 2));
} else {
  const out = argValue('--out');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
  }
  if (process.argv.includes('--write')) {
    const written = await writeUsageProjection({ dataRoot, projection });
    console.error(`usage projection written to ${written}`);
  }
  console.log(JSON.stringify(projection, null, 2));
}
if (projection.complete === false || projection.recordsComplete === false) process.exitCode = 3;
