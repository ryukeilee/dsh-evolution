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
 *     matching `tool/ptc-dispatch-start`). A dispatch whose parent is a native
 *     `tool/call` row in the session is `workflowInvocations`; a dispatch the
 *     log cannot tie to a model-selected call, and a start with no final
 *     dispatch, are `unattributedInvocations`;
 *   - every other native call is `workflowInvocations`: a real session that
 *     chose the capability;
 *   - a call made under a lifecycle call that never returned (crashed or
 *     truncated log) is `unattributedInvocations`; it is neither usage nor
 *     verification, and it stops "zero" from supporting a retirement
 *     recommendation;
 *   - both current-generation encodings are scanned (`session.v4.jsonl.zstd`
 *     and plaintext `session.v4.jsonl`). Any other canonical session log
 *     (`session.jsonl`, `session.vN.jsonl[.zstd]`) is reported as unscanned and
 *     makes the projection incomplete rather than a measured zero;
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
 *     [--write] [--assessments <file>]
 *
 * `--write` persists the projection at `<DSH_HOME>/storages/evolution/shared-plugins/usage.json`,
 * which is the only place the explicit `evolution_plan` / `evolution_desktop
 * audit` reads. The persisted file is a counts table (record id, counts, tool
 * assessment); it never contains transcript text, tool arguments or results.
 *
 * Exits 3 when the scan is incomplete (the projection is still printed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { summarizeCapabilityUsage, writeUsageProjection } from '../../../lib/capability-usage.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const home = path.resolve(argValue('--home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
const dataRoot = path.join(home, 'storages', 'evolution');

let assessments = {};
const assessmentsFile = argValue('--assessments');
if (assessmentsFile) assessments = JSON.parse(fs.readFileSync(path.resolve(assessmentsFile), 'utf8'));

const projection = await summarizeCapabilityUsage({
  dataRoot,
  sessionsRoot: path.join(home, 'sessions'),
  assessments,
});

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
if (projection.complete === false || projection.recordsComplete === false) process.exitCode = 3;
