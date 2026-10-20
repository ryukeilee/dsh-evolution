// Review round 2 (P1): the credential boundary was total for *text* and blind to
// *structure*, and two durable surfaces never reached it at all.
//
// 1. `redactCredentialShapes` inspects one string's own bytes, so a key and its
//    value that are already separated as an object property can never match it:
//
//      { access_token: "<secret>" }            -> persisted verbatim
//      { body: { access_token: "<secret>" } }  -> persisted verbatim
//      { items: [{ api_key: "<secret>" }] }    -> persisted verbatim
//
//    The key list was already there; only the *structural* form of the rule was
//    missing. `compactValue` now decides on the key alone (normalized, derived
//    from the one `CREDENTIAL_KEY` list) and replaces that entry's value
//    wholesale at every depth, whatever its type.
//
// 2. The archive renderer and the observation capture stored free text that only
//    ever passed `optionalText()`, so `why`, `impactScope`, `successMetrics`,
//    `benefitEvidence` and `cleanupEvidence` were rendered into `exp-*.md`
//    untouched. Both now project through the same boundary.
//
// 3. Two residuals from round 1: a bare value that continued into `, "<quoted
//    prose>"` kept the prose (the comma boundary existed for `,"key":` and was
//    not restricted to it), and a value that opened a quote and never closed it
//    survived verbatim. ROUND 7 removed the whole concept instead of tightening
//    it again: after a credential key and its separator the value is the rest of
//    the text, so `, "<quoted prose>"`, a closing quote and a JSON sibling key
//    are all inside the value. The assertions below are the new fail-closed
//    expectations; the boundary constants they used to name no longer exist.
//
// The negative half is asserted too: ordinary evidence is not redacted, the
// `raw|stdout|...` drop list still drops, and the Markdown a credential-free
// record produces is byte-identical to what it produced before this change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EvolutionMemory,
  EvolutionOrchestrator,
  renderExperimentArchive,
  safeErrorDto,
  writeDurablePromotion,
} from '../lib/orchestrator.js';
import {
  promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const SECRET = 'Z7r6Secret9Qx4Lm2Vb8Np1';
const COMPOSITION = { name: 'structural', purpose: 'structural', code: { host: HOST_CODE } };

/**
 * `compactValue` is internal, and that is deliberate: nothing outside this module
 * may bypass the boundary by calling it. The observable path used here is the
 * failure memory, which stores the compacted `evidence` object verbatim in its
 * durable record, so what this returns is exactly the bytes a durable record
 * keeps.
 */
function compacted(value) {
  const memory = new EvolutionMemory({});
  memory.record({ evidence: value });
  return memory.snapshot().entries[0].evidence;
}

function summaryOf(text) {
  return safeErrorDto(new Error(text), 'trial').errorSummary;
}

async function harness(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-review-structural-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  await fs.writeFile(paths.compositionPath, '[]\n');
  const ctx = orchestratorContext();
  let installed = false;
  ctx.dynamicCordisRunner = {
    snapshot: () => (installed ? [{ pluginId: 'review-plugin', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'review-plugin', packageId: 'review-package' }; },
    run: async () => ({ ok: true, status: 'active' }),
    stop: async () => { installed = false; return { ok: true }; },
    undefine: async () => { installed = false; return { ok: true }; },
    inspectPackage: () => ({ code: { host: HOST_CODE } }),
  };
  const core = new EvolutionOrchestrator(ctx, {
    ...paths,
    startupDrift: false,
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(root, 'memory.json'),
  });
  return { root, paths, core, exec: execFor('review-owner') };
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. Structured keys: one rule, every depth, every value shape.
// ---------------------------------------------------------------------------

test('a credential key replaces its value wholesale, at every depth and in every shape', () => {
  const cases = [
    { name: 'the audit shape', value: { access_token: SECRET }, expected: { access_token: '[redacted]' } },
    { name: 'camelCase', value: { apiKey: SECRET }, expected: { apiKey: '[redacted]' } },
    { name: 'a short password', value: { password: 'hunter2' }, expected: { password: '[redacted]' } },
    { name: 'a short token', value: { token: 'abc123def456' }, expected: { token: '[redacted]' } },
    { name: 'upper case and hyphens', value: { 'API-KEY': SECRET }, expected: { 'API-KEY': '[redacted]' } },
    { name: 'the x- prefix', value: { 'x-api-key': SECRET }, expected: { 'x-api-key': '[redacted]' } },
    { name: 'the dot spelling', value: { 'api.key': SECRET }, expected: { 'api.key': '[redacted]' } },
    { name: 'a word prefix', value: { db_password: SECRET }, expected: { db_password: '[redacted]' } },
    { name: 'a session key', value: { session_id: SECRET }, expected: { session_id: '[redacted]' } },
    { name: 'a client secret', value: { client_secret: SECRET }, expected: { client_secret: '[redacted]' } },
    { name: 'nested under an ordinary key', value: { body: { access_token: SECRET } }, expected: { body: { access_token: '[redacted]' } } },
    { name: 'an array of objects', value: { items: [{ api_key: SECRET }] }, expected: { items: [{ api_key: '[redacted]' }] } },
    { name: 'a container', value: { credentials: { value: SECRET } }, expected: { credentials: '[redacted]' } },
    { name: 'a number', value: { token: 12345 }, expected: { token: '[redacted]' } },
    { name: 'an array value', value: { tokens: [SECRET, 'plain'] }, expected: { tokens: '[redacted]' } },
    { name: 'a boolean value', value: { password: true }, expected: { password: '[redacted]' } },
  ];
  for (const entry of cases) {
    assert.deepEqual(compacted(entry.value), entry.expected, `${entry.name}: ${JSON.stringify(entry.value)}`);
    assert.equal(JSON.stringify(compacted(entry.value)).includes(SECRET), false, `${entry.name}: no plaintext survives`);
  }
  // The whole-value rule is unconditional: a credential key's value is not
  // inspected, so a mixed entry loses its ordinary-looking siblings too. That is
  // the fail-closed direction, asserted rather than left implicit.
  assert.deepEqual(compacted({ api_key: { id: 'public', value: SECRET } }), { api_key: '[redacted]' });
  // Depth: past the compaction bound the container itself is withheld rather than
  // walked, which is still a fail-closed answer (nothing is persisted).
  const deep = { a: { b: { c: { d: { token: SECRET } } } } };
  assert.equal(JSON.stringify(compacted(deep)).includes(SECRET), false, 'a secret below the depth bound is withheld with its container');
});

test('ordinary evidence is not redacted, and the raw-output drop list is unchanged', () => {
  // The negative half of the rule. Over-redaction here would silently empty the
  // evidence a promotion gate reads.
  assert.deepEqual(
    compacted({ note: 'the host was unreachable', retries: 3 }),
    { note: 'the host was unreachable', retries: 3 },
  );
  assert.deepEqual(
    compacted({ message: 'tokenizer ran', status: 'ok', count: 2, errors: [] }),
    { message: 'tokenizer ran', status: 'ok', count: 2, errors: [] },
  );
  assert.deepEqual(
    compacted({ observationWindow: '1h', sampleCount: 3, metrics: { errors: 0, latency: 12 } }),
    { observationWindow: '1h', sampleCount: 3, metrics: { errors: 0, latency: 12 } },
  );
  // The drop list this change did not touch: these keys never reach a record.
  assert.deepEqual(
    compacted({ raw: 'x', fullOutput: 'x', stdout: 'x', stderr: 'x', log: 'x', logs: 'x', transcript: 'x', kept: 'yes' }),
    { kept: 'yes' },
  );
  // `__proto__` still survives as an own property instead of hitting the setter.
  const proto = compacted(JSON.parse(`{"__proto__":{"polluted":true},"note":"ok"}`));
  assert.deepEqual(Object.keys(proto).sort(), ['__proto__', 'note']);
});

test('a key that cannot be normalized is redacted rather than passed through', () => {
  // Fail closed: the key decides, and a key with no alphanumeric character
  // decides nothing.
  assert.deepEqual(compacted({ '___': SECRET }), { '___': '[redacted]' });
  assert.deepEqual(compacted({ '!': SECRET }), { '!': '[redacted]' });
});

test('the accepted over-redaction of the key rule is exactly this, and is documented', () => {
  // A key word inside a longer name is a credential for this rule, because
  // normalization removes the separators that once kept `maxTokens` out of the
  // text rule's reach. The cost is a lost metric; the alternative is a kept
  // credential, and the rule is deliberately biased that way.
  assert.deepEqual(compacted({ maxTokens: 512 }), { maxTokens: '[redacted]' });
  // A name that only *contains* the letters without being a word of the family is
  // still kept: `tokenizer` is not `token` + plural.
  assert.deepEqual(compacted({ tokenizer: 'plain' }), { tokenizer: 'plain' });
});

// ---------------------------------------------------------------------------
// 2. Archive fields that never reached any redactor.
// ---------------------------------------------------------------------------

test('every proposal and observation field rendered into exp-*.md crosses the boundary', () => {
  const render = (extra) => renderExperimentArchive({
    id: 'exp-probe', state: 'failed', reason: 'failed', ...extra,
  });
  const cases = [
    { name: 'proposal.why', args: { proposal: { why: `why: Authorization: Bearer aa ${SECRET}` } } },
    { name: 'proposal.impactScope', args: { proposal: { impactScope: [`scope api_key: ${SECRET}`] } } },
    { name: 'proposal.successMetrics', args: { proposal: { successMetrics: [`metric token: ${SECRET}`] } } },
    { name: 'observations[].benefitEvidence', args: { observations: [{ benefitEvidence: `Authorization: Bearer aa ${SECRET}` }] } },
    { name: 'observations[].cleanupEvidence', args: { observations: [{ cleanupEvidence: `api_key: ${SECRET}` }] } },
    { name: 'latestMeasurement.benefitEvidence', args: { latestMeasurement: { benefitEvidence: `api_key: ${SECRET}` } } },
    { name: 'a structured metric', args: { observations: [{ metrics: { access_token: SECRET } }] } },
    { name: 'the measurement as a structured record', args: { latestMeasurement: { evidence: { client_secret: SECRET } } } },
  ];
  for (const entry of cases) {
    const markdown = render(entry.args);
    assert.equal(markdown.includes(SECRET), false, `${entry.name} reached exp-*.md`);
    // The redaction is visible, not a silently emptied field.
    assert.match(markdown, /\[redacted\]/, `${entry.name}: the marker survives`);
  }
  // The document still parses as the shape the reader expects.
  const markdown = render({
    proposal: { why: `api_key: ${SECRET}`, impactScope: ['scope'], successMetrics: ['errors'] },
    observations: [{ cleanupEvidence: `api_key: ${SECRET}` }],
  });
  assert.match(markdown, /^## Proposal$/m);
  assert.match(markdown, /^- why: api_key: \[redacted\]$/m);
  assert.match(markdown, /^## Observations$/m);
  assert.deepEqual(
    JSON.parse(markdown.split('`json\n')[1].split('\n```')[0]),
    [{ cleanupEvidence: 'api_key: [redacted]' }],
  );
});

test('a credential-free record renders byte for byte as before', () => {
  // Pinned against the exact bytes the pre-change renderer produced for this
  // fixture. The projection lifts `compactValue`'s row bounds, so no truncation,
  // item cap or depth compaction can reach an archive document: the only thing
  // that changes a credential-free record is the credential rule itself.
  const markdown = renderExperimentArchive({
    id: 'exp-bytes',
    state: 'stable',
    reason: 'stable-commit',
    proposal: {
      owner: 'owner-bytes',
      createdAt: '2026-01-01T00:00:00.000Z',
      why: 'reduce duplicate recall work',
      target: 'plugin:recall',
      impactScope: ['recall', 'memory'],
      successMetrics: ['errors', 'latency'],
    },
    pluginId: 'plugin-a',
    packageId: 'package-a',
    observations: [
      { at: '2026-01-01T00:00:01.000Z', solvesProblem: true, sideEffects: [], metrics: { errors: 0, latency: 12 }, benefitEvidence: 'the host was unreachable twice, then recovered', cleanupEvidence: 'no orphan resources', repeatable: true },
    ],
    latestMeasurement: { solvesProblem: true, metrics: { errors: 0 }, sampleCount: 3, observationWindow: '1h', note: 'the host was unreachable' },
    recoveryProof: { status: 'recovered', checks: [{ name: 'startup', ok: true }] },
    recovered: true,
    failure: null,
    memorySignature: 'abc123',
    duplicateCount: 2,
    retention: 200,
    canary: null,
  });
  const expected = [
    '# Evolution experiment exp-bytes',
    '',
    '- state: stable',
    '- terminal reason: stable-commit',
    '- owner: owner-bytes',
    '- created: 2026-01-01T00:00:00.000Z',
    '- source package: plugin-a/package-a',
    '',
    '## Proposal',
    '- why: reduce duplicate recall work',
    '- target: plugin:recall',
    '- impact: recall, memory',
    '- success metrics: errors; latency',
    '',
    '## Observations',
    '```json',
    '[',
    '  {',
    '    "at": "2026-01-01T00:00:01.000Z",',
    '    "solvesProblem": true,',
    '    "sideEffects": [],',
    '    "metrics": {',
    '      "errors": 0,',
    '      "latency": 12',
    '    },',
    '    "benefitEvidence": "the host was unreachable twice, then recovered",',
    '    "cleanupEvidence": "no orphan resources",',
    '    "repeatable": true',
    '  }',
    ']',
    '```',
    '',
    '## Latest measurement',
    '```json',
    '{',
    '  "solvesProblem": true,',
    '  "metrics": {',
    '    "errors": 0',
    '  },',
    '  "sampleCount": 3,',
    '  "observationWindow": "1h",',
    '  "note": "the host was unreachable"',
    '}',
    '```',
    '',
    '## Runtime recovery',
    '- recovered: true',
    '- proof: {"status":"recovered","checks":[{"name":"startup","ok":true}]}',
    '',
    '## Failure learning',
    '```json',
    '{',
    '  "status": "none"',
    '}',
    '```',
    '',
    '## Memory lifecycle',
    '- signature: abc123',
    '- duplicate count: 2',
    '- retention: bounded to 200 compact records',
    '',
  ].join('\n');
  assert.equal(markdown, expected);
  // A proposal that is absent still renders the same empty fields, not
  // `undefined`: the projection may not change the document's shape.
  assert.match(renderExperimentArchive({ id: 'exp-empty', state: 'proposed' }), /^- owner: unknown$/m);
  assert.match(renderExperimentArchive({ id: 'exp-empty', state: 'proposed' }), /^- why: $/m);
  // `observations`/`latestMeasurement` stay absent (empty line) as before. This
  // literal is the exact pre-change output for this call, verified against the
  // pre-change module.
  assert.equal(
    renderExperimentArchive({ id: 'exp-empty', state: 'proposed' }),
    '# Evolution experiment exp-empty\n\n- state: proposed\n- terminal reason: undefined\n- owner: unknown\n- created: unknown\n- source package: none/none\n\n## Proposal\n- why: \n- target: \n- impact: \n- success metrics: \n\n## Observations\n```json\n\n```\n\n## Latest measurement\n```json\n\n```\n\n## Runtime recovery\n- recovered: undefined\n- proof: {"status":"unknown"}\n\n## Failure learning\n```json\n{\n  "status": "none"\n}\n```\n\n## Memory lifecycle\n- signature: undefined\n- duplicate count: undefined\n- retention: bounded to undefined compact records\n',
  );
});

// ---------------------------------------------------------------------------
// 3. The two residuals round 1 surfaced.
// ---------------------------------------------------------------------------

test('a comma does not end a value, and no sibling key survives it', () => {
  // The residual: `,` + a quoted run ended the value, so quoted prose after the
  // comma kept the material. There is no comma boundary at all now.
  assert.equal(summaryOf(`Authorization: Bearer aa, "${SECRET}"`), 'Authorization: [redacted]');
  assert.equal(summaryOf(`Authorization: Bearer aa, "${SECRET}"`).includes(SECRET), false);
  assert.equal(summaryOf(`Cookie: a=b, "${SECRET}"`), 'Cookie: [redacted]');
  // The JSON-field survival the old comma boundary existed for is gone with it:
  // the comma and everything after a credential value are the value.
  assert.equal(summaryOf(`{"token":"k=v","x":"y"}`), '{"token":[redacted]');
  assert.equal(summaryOf(`token: k=v,"x":"y"`), 'token: [redacted]');
  assert.equal(summaryOf(`{"password":"${SECRET}","retry":3}`), '{"password":[redacted]');
  assert.throws(() => JSON.parse(summaryOf(`{"password":"${SECRET}","retry":3}`)), SyntaxError,
    'the accepted cost: the redacted document is a fragment');
});

test('a value that opens a quote and never closes it is redacted like every other value', () => {
  // The residual: a truncated message kept the whole value because the quoted
  // branches needed a closing quote. The value is now the whole remainder, so
  // closed and unclosed forms take the same path and the opening quote, which sits
  // after the separator and therefore inside the value, is dropped with it.
  assert.equal(summaryOf(`password="unterminated ${SECRET}`), 'password=[redacted]');
  assert.equal(summaryOf(`token='unterminated ${SECRET}`), 'token=[redacted]');
  // The document's own trailing punctuation is consumed with the value. That is
  // the accepted cost of never keeping a truncated credential.
  assert.equal(summaryOf(`{"password":"unterminated ${SECRET}`), '{"password":[redacted]');
  assert.equal(summaryOf(`password="unterminated ${SECRET}`).includes(SECRET), false);
  // A value that does close is not treated differently from one that does not:
  // there is no closing-quote branch left to distinguish it.
  assert.equal(summaryOf(`{"password":"${SECRET}","retry":3}`), '{"password":[redacted]');
});

test('the residual this round does not close: an unlabelled high-entropy value', () => {
  // Recorded as a residual, not hidden. `provider rejected <23 random characters>`
  // carries no key from `CREDENTIAL_KEY`, no vendor prefix and no scheme, so no
  // rule in the one table matches it. Detecting it would need a high-entropy
  // heuristic, i.e. a new rule family; this round did not add one, and the field
  // now at least crosses the boundary instead of bypassing it.
  const text = `provider rejected ${SECRET}`;
  assert.equal(summaryOf(text), text, 'an unlabelled secret is still not redacted by the text rule');
  const markdown = renderExperimentArchive({
    id: 'exp-residual', state: 'failed', reason: 'failed',
    latestMeasurement: { benefitEvidence: text },
  });
  assert.equal(markdown.includes(SECRET), true, 'the residual is asserted, so a future closure of it is not silent');
  // The same field *with* a credential shape is covered, which is what the field
  // routing changed.
  assert.equal(renderExperimentArchive({
    id: 'exp-residual', state: 'failed', reason: 'failed',
    latestMeasurement: { benefitEvidence: `provider rejected api_key: ${SECRET}` },
  }).includes(SECRET), false);
});

test('the dot spelling is a separator, so api.key and access.token match', () => {
  for (const text of [`api.key: ${SECRET}`, `client.secret: ${SECRET}`, `access.token: ${SECRET}`, `db.password=${SECRET}`]) {
    assert.equal(summaryOf(text).includes(SECRET), false, `the dot spelling is covered: ${text}`);
    assert.match(summaryOf(text), /\[redacted\]/);
  }
  // Ordinary prose with a dot and a colon is not a credential: the key still has
  // to be a word of the family.
  assert.equal(summaryOf('schema.version: 2'), 'schema.version: 2');
  assert.equal(summaryOf('see the api.key rotation doc'), 'see the api.key rotation doc');
});

// ---------------------------------------------------------------------------
// 4. The capture side: measure() stores what the boundary produced.
// ---------------------------------------------------------------------------

test('measure() stores projected evidence and the bridge carries no plaintext', async (t) => {
  const h = await harness(t, 'measure');
  const proposal = h.core.propose({
    why: `why: api_key: ${SECRET}`,
    target: 'plugin:structural',
    impactScope: [`scope token: ${SECRET}`],
    successMetrics: [`metric password=${SECRET}`],
  }, h.exec);
  // The proposal text is durable and is also echoed to the caller: one value, one
  // projection, so the caller cannot receive a different string than the record.
  assert.equal(JSON.stringify(proposal.proposal).includes(SECRET), false, 'the proposal is projected where it is captured');
  assert.equal(h.core.experiments.get(proposal.experimentId).proposal.why, 'why: api_key: [redacted]');

  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  const measured = await h.core.measure({
    experimentId: proposal.experimentId,
    observation: {
      solvesProblem: true,
      metrics: { errors: 0, access_token: SECRET },
      beforeMetrics: { errors: 1 },
      afterMetrics: { errors: 0 },
      observationWindow: `window api_key: ${SECRET}`,
      sampleCount: 2,
      benefitEvidence: `benefit api_key: ${SECRET}`,
      cleanupEvidence: `cleanup token: ${SECRET}`,
      repeatable: true,
      regressionPassed: true,
      reversible: true,
    },
  }, h.exec);

  assert.equal(JSON.stringify(measured.observation).includes(SECRET), false, 'the observation is projected where it is captured');
  assert.equal(measured.observation.benefitEvidence, 'benefit api_key: [redacted]');
  assert.equal(measured.observation.cleanupEvidence, 'cleanup token: [redacted]');
  assert.deepEqual(measured.observation.metrics, { errors: 0, access_token: '[redacted]' });
  assert.equal(measured.observation.observationWindow, 'window api_key: [redacted]');
  // The gates read the projected values and still see evidence: redaction may not
  // turn a passing gate into a failing one, and the credential-shaped metric is
  // still counted as a metric key present.
  assert.equal(measured.gates.cleanupEvidence, true);
  assert.equal(measured.gates.realBenefit, true);

  // Every durable surface that carries the measurement.
  const bridge = await readText(h.paths.eventBridgePath);
  assert.ok(bridge.length > 0, 'the event bridge was written');
  assert.equal(bridge.includes(SECRET), false, 'the bridge carries no plaintext');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(renderExperimentArchive({
    id: record.id,
    state: record.state,
    reason: 'measured',
    proposal: record.proposal,
    observations: record.observations,
    latestMeasurement: record.latestObservation,
    recovered: false,
  }).includes(SECRET), false, 'the rendered archive carries no plaintext');
});

// ---------------------------------------------------------------------------
// 5. The promotion lock token is not on the compactValue path.
// ---------------------------------------------------------------------------

test('the promotion lock keeps a real ownership token, because it bypasses compactValue', async (t) => {
  const h = await harness(t, 'lock');
  let seen = null;
  // `verify` runs inside the transaction, so the lock file it reads is the one
  // `writeDurablePromotion` created for this commit.
  h.paths.promotionRuntime.verify = async () => {
    seen = JSON.parse(await fs.readFile(path.join(h.paths.promotionLockPath, 'lock.json'), 'utf8'));
    return { officialInclude: true, active: true };
  };
  await writeDurablePromotion({
    experiment: {
      id: 'exp-lock',
      ownerId: 'review-owner',
      state: 'promoting',
      proposal: { owner: 'review-owner', why: 'lock', target: 'plugin:lock', impactScope: ['test'], successMetrics: ['unit'], createdAt: '2026-01-01T00:00:00.000Z' },
      runtimeRecovered: true,
      observations: [],
      latestObservation: {},
    },
    paths: h.paths,
    packageInspection: { code: { host: HOST_CODE } },
  });
  assert.ok(seen, 'the lock was observed while the transaction held it');
  assert.match(seen.token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the lock token is the real UUID that proves ownership');
  assert.notEqual(seen.token, '[redacted]', 'the lock token is never redacted');
  // The contrast that makes the previous line meaningful: the same field name
  // *through* compactValue is redacted, so a `token` key on this path would have
  // broken ownership (the finally-block comparison could never match).
  assert.deepEqual(compacted({ token: seen.token }), { token: '[redacted]' });
  await assert.rejects(fs.readFile(path.join(h.paths.promotionLockPath, 'lock.json'), 'utf8'), /ENOENT/, 'the lock is released after the commit');
});

// ---------------------------------------------------------------------------
// 6. Review round 3: `measure()` metrics keep their row bounds.
//
// Round 2 routed `metrics` / `beforeMetrics` / `afterMetrics` through
// `EVIDENCE_PROJECTION` (the archive projection, whose bounds are lifted), which
// was wrong for this field: a measurement row is a bounded telemetry row that was
// already bounded before round 2, so a caller could inflate the durable
// observation, the evidence sidecar, `exp-*.md` and the bridge payload without
// limit. Both halves are pinned here, because the cheap "fix" for the bound is to
// stop projecting the object at all, which would keep the gigabyte and lose the
// credential rule.
// ---------------------------------------------------------------------------

const LONG_TEXT = 'x'.repeat(5000);
// 200 items of 64 characters: ~13.4 KB in, and the row bound keeps 8.
const MANY_ROWS = Array.from({ length: 200 }, (_, i) => `row-${String(i).padStart(3, '0')}-${'y'.repeat(56)}`);

async function measureOnce(h, label, observation) {
  const proposal = h.core.propose({
    why: 'bounds probe', target: `plugin:${label}`, impactScope: ['bounds'], successMetrics: ['errors'],
  }, h.exec);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  return h.core.measure({ experimentId: proposal.experimentId, observation }, h.exec);
}

test('measure() metrics are bounded at 8 items and 1200 characters, exactly as before round 2', async (t) => {
  const h = await harness(t, 'bounds');
  const measured = await measureOnce(h, 'bounds', {
    solvesProblem: true,
    metrics: { rows: MANY_ROWS, note: LONG_TEXT },
    beforeMetrics: { rows: MANY_ROWS },
    afterMetrics: { note: LONG_TEXT },
  });
  const { metrics, beforeMetrics, afterMetrics } = measured.observation;

  // The exact stored shape, not merely "smaller": the object branch of
  // `compactValue` keeps the first `maxItems` entries and drops the rest, and the
  // string branch keeps `maxText` characters plus the truncation marker.
  assert.deepEqual(metrics.rows, MANY_ROWS.slice(0, 8), 'the array keeps exactly its first 8 entries, unchanged');
  assert.equal(metrics.note, `${'x'.repeat(1200)}…[truncated]`, 'the text keeps 1200 characters plus the marker');
  assert.deepEqual(beforeMetrics.rows, MANY_ROWS.slice(0, 8), 'beforeMetrics crosses the same row bound');
  assert.equal(afterMetrics.note, `${'x'.repeat(1200)}…[truncated]`, 'afterMetrics crosses the same row bound');

  // Byte level, so the assertion fails on any future bound widening even if the
  // shape assertions were loosened. Measured on the pre-fix tree for this same
  // probe: 13,410 bytes (200 rows kept) and 5,011 bytes (5,000 characters kept)
  // reached the record. With the row bounds back: 8 rows = 537 bytes,
  // 1,200 characters + marker = 1,214 bytes, 1,770 bytes for both.
  assert.equal(Buffer.byteLength(JSON.stringify(metrics.rows), 'utf8'), 537, 'the bounded array is 537 bytes');
  assert.equal(Buffer.byteLength(metrics.note, 'utf8'), 1214, 'the bounded text is 1,214 bytes (1,212 characters)');
  assert.equal(Buffer.byteLength(JSON.stringify({ rows: metrics.rows, note: metrics.note }), 'utf8'), 1770, 'the stored metrics object is 1,770 bytes, not 18,421');

  // The durable surfaces are bounded too: the tail of the array never reaches the
  // record, the bridge payload or the rendered archive.
  const record = h.core.experiments.get(measured.experimentId);
  assert.deepEqual(record.observations.at(-1).metrics.rows, MANY_ROWS.slice(0, 8));
  const bridge = await readText(h.paths.eventBridgePath);
  assert.ok(bridge.length > 0, 'the event bridge was written');
  assert.equal(bridge.includes(MANY_ROWS[199]), false, 'an entry past the row bound does not reach the bridge');
  assert.equal(bridge.includes('y'.repeat(4000)), false, 'text past the row bound does not reach the bridge');
  const archive = renderExperimentArchive({
    id: record.id,
    state: record.state,
    reason: 'measured',
    proposal: record.proposal,
    observations: record.observations,
    latestMeasurement: record.latestObservation,
    recovered: false,
  });
  assert.equal(archive.includes(MANY_ROWS[199]), false, 'an entry past the row bound does not reach exp-*.md');
});

test('restoring the row bounds does not narrow the credential rule: metrics stay redacted', async (t) => {
  const h = await harness(t, 'bounds-redaction');
  const measured = await measureOnce(h, 'bounds-redaction', {
    solvesProblem: true,
    metrics: {
      token: SECRET,
      nested: { api_key: SECRET },
      rows: [{ password: SECRET }],
      kept: { note: 'ordinary evidence', latency: 12 },
    },
    beforeMetrics: { token: SECRET },
    afterMetrics: { nested: { api_key: SECRET } },
  });
  const { metrics, beforeMetrics, afterMetrics } = measured.observation;

  // The key-aware rule lives inside `compactValue`'s object branch, so restoring
  // the bounds changes no redaction decision.
  assert.deepEqual(metrics, {
    token: '[redacted]',
    nested: { api_key: '[redacted]' },
    rows: [{ password: '[redacted]' }],
    kept: { note: 'ordinary evidence', latency: 12 },
  });
  assert.deepEqual(beforeMetrics, { token: '[redacted]' });
  assert.deepEqual(afterMetrics, { nested: { api_key: '[redacted]' } });
  assert.equal(JSON.stringify(measured.observation.metrics).includes(SECRET), false, 'no plaintext survives the bound');

  // And it does not leak through any durable surface either.
  assert.equal(JSON.stringify(measured.observation).includes(SECRET), false, 'the observation carries no plaintext');
  assert.equal((await readText(h.paths.eventBridgePath)).includes(SECRET), false, 'the bridge carries no plaintext');
  const record = h.core.experiments.get(measured.experimentId);
  assert.equal(renderExperimentArchive({
    id: record.id,
    state: record.state,
    reason: 'measured',
    proposal: record.proposal,
    observations: record.observations,
    latestMeasurement: record.latestObservation,
    recovered: false,
  }).includes(SECRET), false, 'exp-*.md carries no plaintext');
});

test('the telemetry path bounds the same metric object, which is why measure() must too', () => {
  // The contrast that makes the measure() bound the consistent choice: the other
  // caller-supplied metric object in this module (`observeCanary`) was never moved
  // to the archive projection, and the failure-memory row is bounded as well.
  const memory = new EvolutionMemory({});
  memory.record({ evidence: { rows: MANY_ROWS, note: LONG_TEXT } });
  const kept = memory.snapshot().entries[0].evidence;
  assert.deepEqual(kept.rows, MANY_ROWS.slice(0, 8), 'the telemetry row keeps 8 entries');
  assert.equal(kept.note, `${'x'.repeat(1200)}…[truncated]`, 'the telemetry row keeps 1,200 characters plus the marker');
});
