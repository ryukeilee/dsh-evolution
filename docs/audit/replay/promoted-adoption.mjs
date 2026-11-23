#!/usr/bin/env node
/**
 * Read-only evidence: what the published capabilities actually did.
 *
 * This is not a second scanner. It calls the same two implementations the
 * runtime audit uses — `summarizeCapabilityUsage()` for the call counts and
 * `readPublishedPluginReview()` for the value verdict — so the table it prints
 * cannot disagree with `evolution_plan` / `evolution_desktop audit`.
 *
 * It answers two separate questions per published record, because conflating
 * them is what hid the 2026-11-18 negative result:
 *
 *   - **was it invoked?** a tool call the model made (`workflowInvocations`);
 *   - **did its mechanism run?** for a context-policy capability there is no
 *     call to count, so the durable paired-session artifact in the promotion
 *     evidence sidecar is the only fact that can answer it
 *     (`taskBenefit.adoption.sessionsExercised` / `mechanismRan`).
 *
 * Usage:
 *   node docs/audit/replay/promoted-adoption.mjs [--home <DSH_HOME>] [--json]
 *
 * Exits 3 when the scan itself is incomplete (the projection is still printed).
 */
import os from 'node:os';
import path from 'node:path';

import { summarizeCapabilityUsage } from '../../../lib/capability-usage.js';
import { readPublishedPluginReview } from '../../../lib/self-evolution-review.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const home = path.resolve(argValue('--home') ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
const dataRoot = path.join(home, 'storages', 'evolution');
const paths = { dataRoot, presetDir: dataRoot, pluginRoot: path.join(dataRoot, 'promoted') };

const usage = await summarizeCapabilityUsage({ dataRoot, sessionsRoot: path.join(home, 'sessions') });

// The host identity is deliberately left unresolved here: this replay reports
// value, not compatibility, and a guessed host would change the status column.
const review = await readPublishedPluginReview({ paths, host: null, usage, usageStatus: 'ok' });

const rows = review.records.map((record) => ({
  id: record.id,
  status: record.status,
  tier: record.value.tier,
  measurement: record.value.measurement,
  invoked: record.value.invoked,
  workflowInvocations: record.value.workflowInvocations,
  benefitProvenance: record.value.benefitProvenance,
  experimentBenefit: record.value.experimentBenefit,
  adoption: record.value.adoption,
  retirementCandidate: review.retirementCandidates.some((row) => row.recordId === record.id),
}));

const document = {
  kind: 'dsh-evolution-promoted-adoption',
  readOnly: true,
  capturedAt: usage.capturedAt,
  sessionsRoot: usage.sessionsRoot,
  scannedSessions: usage.scannedSessions,
  scannedToolCalls: usage.scannedToolCalls,
  complete: usage.complete,
  recordsComplete: usage.recordsComplete,
  uncountableRecords: usage.uncountableRecords ?? [],
  valueSummary: review.valueSummary,
  records: rows,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(document, null, 2));
} else {
  console.log(`${document.scannedSessions} sessions, ${document.scannedToolCalls} tool calls, scanComplete=${document.complete}, recordsComplete=${document.recordsComplete}`);
  console.log(`value: ${JSON.stringify(document.valueSummary)}`);
  console.log('');
  console.log('record                                  tier                invoked  wf     provenance        mechanism');
  for (const row of rows) {
    const mechanism = row.adoption
      ? `ran in ${row.adoption.sessionsExercised ?? '?'} session(s), selected in ${row.adoption.sessionsUsingCandidate ?? '?'}`
      : (row.measurement === 'no-tool-surface' ? 'no paired evidence' : 'n/a');
    console.log([
      row.id.padEnd(38),
      String(row.tier).padEnd(19),
      String(row.invoked).padEnd(8),
      String(row.workflowInvocations).padEnd(6),
      String(row.benefitProvenance).padEnd(17),
      mechanism,
    ].join(' '));
  }
}

if (usage.complete === false || usage.recordsComplete === false) process.exitCode = 3;
