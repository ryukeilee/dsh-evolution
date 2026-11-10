// The model-facing registration is paid on every model request of a session.
//
// This test pins the three properties the fixed-context reduction is allowed to
// change without giving back:
//   1. the tool names and the parameter *structure* (keys, types, required sets)
//      are unchanged - only prose and descriptions were compressed. The one
//      approved exception is the Propose–Probe–Compose extension, which adds
//      `evolution_plan` and `evolution_probe` and the optional propose fields
//      pinned below;
//   2. the fixed text stays inside 80% of the bytes measured on origin/main
//      `25d6200`, extended by the measured allowance for those two tools (see
//      the constants and formula below; `docs/performance/axis-token-audit.md`
//      holds the ruler and `docs/performance/fixed-context-token-reduction-20261109.md`
//      the reduction and the real-provider token measurement);
//   3. every safety/authorization/lifecycle fact the old text carried is still
//      discoverable in the combined model-facing text (system + descriptions +
//      compiled parameter JSON) after whitespace normalization - the old and new
//      texts wrap lines differently, so a raw `includes` would be a false pass.
//
// The capture goes through `scripts/benchmarks/fixed-context/fixture.mjs`, which
// mounts the official Tools/SystemPrompt plugins and calls the production
// `apply()`, so the compiled schemas here are the ones a host registers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fixture } from '../scripts/benchmarks/fixed-context/fixture.mjs';
import { EVOLUTION_TOOLS } from '../lib/registration.js';

/** Measured UTF-8 bytes per request on origin/main `25d6200`, audit ruler:
 *  systemText + per-tool name + description + compact parameters JSON. */
const ORIGIN_FIELDS_BYTES = 9716;
/** Same fields plus the compact tool array envelope (`JSON.stringify`). */
const ORIGIN_WIRE_BYTES = 10147;

/** Approved fixed-context allowance for the two new tools.
 *
 *  `evolution_plan` and `evolution_probe` are an approved capability extension
 *  (Propose–Probe–Compose), not a regression of the fixed-context reduction: the
 *  origin reduction left only 98 B of fields headroom, so any new tool surface
 *  necessarily exceeds the untouched 80% target. The allowance is the smallest
 *  value that keeps the *same* 20% reduction target over the extended baseline,
 *  measured with the fixture in this file on 2026-11-11:
 *
 *    text   = 2388 B (systemText, 12 tools registered)
 *    fields = systemText + names + descriptions + compiled parameter JSON
 *           = 9633 B;
 *    wire   = systemText + JSON.stringify({name, description, parameters}[])
 *           = 10150 B;
 *    allowance = ceil(ceil((actual - floor(origin * 0.8)) / 0.8) / 50) * 50
 *              = 2350 B fields / 2550 B wire.
 *
 *  So the assertion below is still "at least 20% smaller than the extended
 *  baseline", not an unbounded budget. Adding prose or another tool must raise
 *  the allowance only with a new measurement and this same formula. */
const FIELDS_ALLOWANCE_BYTES = 2350;
const WIRE_ALLOWANCE_BYTES = 2550;
const BASELINE_FIELDS_BYTES = ORIGIN_FIELDS_BYTES + FIELDS_ALLOWANCE_BYTES;
const BASELINE_WIRE_BYTES = ORIGIN_WIRE_BYTES + WIRE_ALLOWANCE_BYTES;

/** The accepted budget is the 20% reduction target, not the measured candidate. */
const FIELDS_BUDGET = Math.floor(BASELINE_FIELDS_BYTES * 0.8);
const WIRE_BUDGET = Math.floor(BASELINE_WIRE_BYTES * 0.8);

// Parameter *semantics* are frozen: same names, types, item shapes, nesting and
// required sets as origin/main `25d6200`. Descriptions are deliberately not part
// of this pin - they are the prose that was compressed - so re-adding a
// description or rewording one does not require editing this fixture.
// Recompute only for an intended parameter-semantics change.
const EXPECTED_PARAMETER_STRUCTURE = JSON.parse(`{
 "evolution_doctor": {"required":[],"properties":{"repair":{"type":"boolean"},"composition":{"type":"boolean"}}},
 "evolution_history": {"required":[],"properties":{"collection":{"type":"string"},"limit":{"type":"number"},"query":{"type":"string"},"target":{"type":"string"},"impactScope":{"type":"array","items":{"type":"string"}}}},
 "evolution_maintain": {"required":[],"properties":{"dryRun":{"type":"boolean"},"confirmation":{"type":"boolean"},"archives":{"type":"boolean"},"log":{"type":"boolean"},"retainRecords":{"type":"number"}}},
 "evolution_runtime_inspect": {"required":[],"properties":{}},
 "evolution_plan": {"required":[],"properties":{"focus":{"type":"string"},"minOccurrences":{"type":"number"},"limit":{"type":"number"}}},
 "evolution_propose": {"required":["why","target","impactScope","successMetrics"],"properties":{"why":{"type":"string"},"target":{"type":"string"},"impactScope":{"type":"array","items":{"type":"string"}},"successMetrics":{"type":"array","items":{"type":"string"}},"risk":{"type":"string"},"strategy":{"type":"string"},"rootCause":{"type":"string"},"targets":{"type":"object","required":[],"properties":{"components":{"type":"array","items":{"type":"string"}},"plugins":{"type":"array","items":{"type":"string"}},"configurations":{"type":"array","items":{"type":"string"}}}}}},
 "evolution_trial": {"required":["experimentId","composition"],"properties":{"experimentId":{"type":"string"},"idPrefix":{"type":"string"},"composition":{"type":"object","required":["name","purpose","code"],"properties":{"name":{"type":"string"},"purpose":{"type":"string"},"code":{"type":"object","required":["host"],"properties":{"host":{"type":"string"},"client":{"type":"string"}}}}}}},
 "evolution_probe": {"required":["experimentId","phase","scenario"],"properties":{"experimentId":{"type":"string"},"phase":{"type":"string"},"scenario":{"type":"object","required":["id","steps"],"properties":{"id":{"type":"string"},"description":{"type":"string"},"repetitions":{"type":"number"},"steps":{"type":"array","items":{"type":"object","required":["name"],"properties":{"name":{"type":"string"},"arguments":{"type":"json"},"role":{"type":"string"}}}}}}}},
 "evolution_measure": {"required":["experimentId","observation"],"properties":{"experimentId":{"type":"string"},"observation":{"type":"object","required":["solvesProblem"],"properties":{"solvesProblem":{"type":"boolean"},"sideEffects":{"type":"array","items":{"type":"string"}},"orphanResources":{"type":"array","items":{"type":"string"}},"performanceChange":{"type":"json"},"errorChange":{"type":"json"},"metrics":{"type":"object"},"beforeMetrics":{"type":"object"},"afterMetrics":{"type":"object"},"observationWindow":{"type":"json"},"sampleCount":{"type":"number"},"benefitEvidence":{"type":"string"},"repeatable":{"type":"boolean"},"regressionPassed":{"type":"boolean"},"reversible":{"type":"boolean"},"cleanupEvidence":{"type":"string"}}}}},
 "evolution_revert": {"required":["experimentId"],"properties":{"experimentId":{"type":"string"}}},
 "evolution_promote": {"required":["experimentId"],"properties":{"experimentId":{"type":"string"},"confirmation":{"type":"boolean"}}},
 "evolution_canary_observe": {"required":["experimentId","startupVerified","componentHealth","dependenciesPresent","metricRegression","barrier"],"properties":{"experimentId":{"type":"string"},"startupVerified":{"type":"boolean"},"componentHealth":{"type":"string"},"dependenciesPresent":{"type":"boolean"},"metricRegression":{"type":"boolean"},"metrics":{"type":"object"},"evidence":{"type":"object"},"barrier":{"type":"object","required":["id","reached"],"properties":{"id":{"type":"string"},"reached":{"type":"boolean"}}}}}
}`);

function shapeOf(schema) {
  if (schema && schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    return {
      type: 'object',
      required: schema.required ?? [],
      properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, shapeOf(value)])),
    };
  }
  if (schema && schema.type === 'array') return { type: 'array', items: shapeOf(schema.items ?? {}) };
  // `normalizeSchema` projects the author-side `type: "json"` (and any untyped
  // description-only node) to an unconstrained JSON schema.
  return { type: (schema && schema.type) || 'json' };
}

function structureOf(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.name, {
    required: tool.parameters.required ?? [],
    properties: Object.fromEntries(Object.entries(tool.parameters.properties ?? {}).map(([key, value]) => [key, shapeOf(value)])),
  }]));
}

const utf8 = (value) => Buffer.byteLength(value, 'utf8');

/** Every must-preserve fact from the pre-reduction text, as one assertion row.
 *  `matcher` is a RegExp or a predicate over the normalized combined text. */
const CONTRACT = [
  ['no second runtime', /second registry/i, /effect tracker/i],
  ['official disposer rule', /ctx\.effect\(\)/, /ctx\.on\(\)/, /disposer/i],
  ['root-cause rule', /root-cause experiment/i],
  ['lifecycle order', (text) => ['evolution_runtime_inspect', 'evolution_propose', 'evolution_trial',
    'evolution_measure', 'evolution_revert', 'evolution_promote']
    .map((name) => text.indexOf(name))
    .every((index, position, indexes) => index >= 0 && (position === 0 || index > indexes[position - 1]))],
  ['discovery order includes plan and probe', (text) => ['evolution_plan', 'evolution_propose',
    'evolution_probe', 'evolution_trial', 'evolution_measure', 'evolution_revert', 'evolution_promote']
    .map((name) => text.indexOf(name))
    .every((index, position, indexes) => index >= 0 && (position === 0 || index > indexes[position - 1]))],
  ['plan is read-only and never starts an experiment', /read-only evidence-ranked/i, /returns none/i, /starts no experiment/i],
  ['probe runs its scenarios through the official tool pipeline', /runs each fixed probe scenario/i, /official tool pipeline/i, /raw samples/i],
  ['measure derives its metrics from probe samples', /derives before\/after metrics/i, /ignores caller-supplied metrics/i],
  ['conclusions are written back with applicability', /experiment conclusion/i, /DSH\/Cordis applicability/i, /same conditions/i],
  ['proven-ineffective strategy is refused', /proven ineffective/i, /same target and applicability/i, /refused/i],
  ['strict order wording', /(exactly in this order|strict order)/i],
  ['dispose through Cordis first', /dispose through Cordis/i],
  ['promotion is Host-only', /Host-only/i],
  ['trial is approval-aware', /approval-aware/i],
  ['all promotion gates', /(every gate|eight)/i, /runtime recovery/i],
  ['owner confirmation required', /owner confirmation/i],
  ['stable commit from barriers', /stable commit/i, /startup/i, /dependencies/i],
  ['promotion persists a durable row/archive pointer for the next session', /durable Plugin row/i, /archive pointer/i, /next session/i],
  ['rollback to last known good', /last known good/i],
  ['recall is advisory', /advisory/i],
  ['recall trigger', /experienceRecall/, /evolution_history/, /query/i],
  ['no repeat without a new hypothesis', /new hypothesis/i],
  ['maintain is the only capacity operation', /only capacity operation/i, /(never a schedule|owner action)/i],
  ['maintain requires confirmation: true', /confirmation: true/i],
  ['evidence externalized before log discard', /externaliz/i, /event.log prefix/i],
  ['maintain refuses without discarding', /without discarding anything/i, /unreadable/i, /pending transaction/i],
  ['unreadable log is refused', /unreadable log/i],
  ['markers pruned behind a retention floor', /markers behind a durable retention floor/i],
  ['authenticated log bytes', /authenticated log bytes/i],
  ['unconfirmed promote is an owner decision', /(owner-confirmation result|read-only confirmation request)/i],
  ['beforeMetrics is the baseline', /baseline metrics (captured )?before the trial/i],
  ['afterMetrics is post-window', /after the (trial )?observation window/i],
  ['doctor repairs are safe and idempotent, journal rollback needs restart', /idempotent/i, /promotion-journal/i],
  ['revert proves the runtime signature', /signature/i, /baseline/i],
  ['trial is owned by the Host Runner', /Host Runner/i],
  ['history is bounded and non-sensitive', /bounded/i, /non-sensitive/i],
  ['observationWindow accepts a string or positive number', /string or positive number/i],
];

test('fixed model context keeps its contract and stays inside the 20% budget', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evolution-fixed-context-'));
  let captured;
  try {
    captured = await fixture(root);
    const { text, tools } = captured;

    await t.test('the declared tool surface and parameter structure are unchanged', () => {
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...EVOLUTION_TOOLS].sort());
      assert.deepEqual(structureOf(tools), EXPECTED_PARAMETER_STRUCTURE);
      for (const tool of tools) {
        assert.ok(tool.description.length > 0, `${tool.name}: description stays model-visible`);
      }
    });

    await t.test('the fixed context is at least 20% smaller than the origin/main baseline', () => {
      const fieldsBytes = utf8(text) + tools.reduce((total, tool) =>
        total + utf8(tool.name) + utf8(tool.description) + utf8(JSON.stringify(tool.parameters)), 0);
      const wire = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      const wireBytes = utf8(text) + utf8(JSON.stringify(wire));
      assert.ok(fieldsBytes <= FIELDS_BUDGET,
        `fixed fields ${fieldsBytes} B exceed the ${FIELDS_BUDGET} B budget (baseline ${BASELINE_FIELDS_BYTES} B)`);
      assert.ok(wireBytes <= WIRE_BUDGET,
        `compact wire envelope ${wireBytes} B exceeds the ${WIRE_BUDGET} B budget (baseline ${BASELINE_WIRE_BYTES} B)`);
    });

    await t.test('every safety, authorization and lifecycle fact is still discoverable', () => {
      const combined = [text, ...tools.map((tool) =>
        `${tool.name} ${tool.description} ${JSON.stringify(tool.parameters)}`)].join(' ').replace(/\s+/g, ' ');
      for (const [fact, ...matchers] of CONTRACT) {
        const present = matchers.every((matcher) =>
          typeof matcher === 'function' ? matcher(combined) : matcher.test(combined));
        assert.ok(present, `missing: ${fact}`);
      }
    });
  } finally {
    await captured?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
