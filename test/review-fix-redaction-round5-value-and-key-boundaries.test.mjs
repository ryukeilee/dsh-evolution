// Review round 5 (final security round): four confirmed plaintext leaks that
// rounds 1-4 missed, and two claims of "non-throwing by construction" that the
// implementations did not hold.
//
// 1. THE VALUE RULE TRUNCATED OR SKIPPED. Three reproduced shapes:
//
//      credentials={"a":{},"value":"<secret>"} -> credentials=[redacted],"value":"<secret>"
//      password=;<secret>                       -> password=;<secret>   (no match at all)
//      Authorization: "Bearer aa" <secret>      -> Authorization: "[redacted]" <secret>
//
//    Causes: the container alternative `[\[{][^\]}]{0,512}[\]}]` stopped at the
//    first inner `}`/`]`; `BARE_VALUE`'s first-character class rejected `,;"'{}[]\`,
//    so a value beginning with `;` was never claimed; and a properly closed quoted
//    value ended the match, leaving what followed it in plaintext.
//
//    Fix, all three fail-closed and with no new rule family: a container value is
//    claimed to the end of the text, the bare value accepts any first character
//    that is not the structural end, and a closed quoted value continues over the
//    shared tail. ROUND 7 REPLACED ALL THREE with one rule — after a credential
//    key and its separator the rest of the text is the value — because each of
//    those boundaries was in turn a way to stop early and leak material. The
//    expectations below are the new fail-closed ones; the constants named in this
//    paragraph (`CONTAINER_VALUE`, `BARE_VALUE`, `VALUE_TAIL`) no longer exist.
//
// 2. STRUCTURED KEY DETECTION WAS WEAKER THAN TEXT DETECTION. `db_api_key`
//    normalized to `dbapikey`, which matched neither the whole name nor one of its
//    words, while the text rule matched `api[-_]?key` inside it. The predicate now
//    also accepts a credential spelling at the END of the normalized key, derived
//    from the same single `CREDENTIAL_KEY` list.
//
// 3. TWO MEASUREMENT FIELDS WERE NEVER PROJECTED. `measure()` built
//    `sideEffects` and `orphanResources` with `stringList` alone, so
//    `sideEffects: ["password=<secret>"]` reached `exp-*.md`, the evidence
//    sidecar, the promotion journal, the event bridge and the rollback path raw.
//
// 4. TWO WRITE PATHS BYPASSED THE FIXED RENDERER: an explicit
//    `payload.measurement` on `EvolutionEventBridge.project()`, and the two raw
//    Markdown renderers (`archive()` and `writeDurablePromotionUnlocked`) that do
//    not call `renderExperimentArchive`.
//
// 5. TWO CONSTRUCTS THAT COULD THROW: `registration.js` read `error.code` again
//    after obtaining the degraded DTO, and `safeErrorEvidence` called
//    `Object.entries` outside a guard.
//
// Every assertion here is behavioural: the observable surfaces are the summary a
// `safeErrorDto` produces, the durability path (`EvolutionMemory`, `exp-*.md`, the
// evidence sidecar, the bridge JSONL) and the real bridge/renderer entry points.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EvolutionEventBridge,
  EvolutionMemory,
  EvolutionOrchestrator,
  persistEvidenceSnapshot,
  safeErrorDto,
  snapshotEvidenceFromRecord,
  writeDurablePromotion,
} from '../lib/orchestrator.js';
import {
  promotionPaths, unitPromotionRuntime, orchestratorContext, execFor, HOST_CODE,
} from './orchestrator-durability-fixtures.mjs';

const SECRET = 'Q7v9ReviewSecret3';
const COMPOSITION = { name: 'round5', purpose: 'round5', code: { host: HOST_CODE } };

function summaryOf(value) {
  return safeErrorDto(new Error(value), 'trial').errorSummary;
}

/**
 * `compactValue` is internal and stays internal: the observable structural
 * boundary is the failure memory, which stores the compacted `evidence` object
 * verbatim in its durable record.
 */
function compacted(value) {
  const memory = new EvolutionMemory({});
  memory.record({ evidence: value });
  return memory.snapshot().entries[0].evidence;
}

async function harness(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `evo-round5-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = promotionPaths(root);
  paths.promotionRuntime = unitPromotionRuntime();
  await fs.writeFile(paths.compositionPath, '[]\n');
  const ctx = orchestratorContext();
  let installed = false;
  ctx.dynamicCordisRunner = {
    snapshot: () => (installed ? [{ pluginId: 'round5-plugin', packages: [] }] : []),
    define: () => { installed = true; return { pluginId: 'round5-plugin', packageId: 'round5-package' }; },
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
  return { root, paths, core, exec: execFor('round5-owner') };
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/** One bridge event, parsed, from a JSONL file the bridge wrote. */
function bridgeEvent(text, eventType) {
  const envelope = text.trim().split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => (record.event || record).eventType === eventType);
  assert.ok(envelope, `${eventType} was emitted`);
  return envelope.event || envelope;
}

// ---------------------------------------------------------------------------
// 1. The value rule: the three reproduced shapes, the shapes that must not
//    regress, and the one JSON shape given up for fail-closed.
// ---------------------------------------------------------------------------

test('a value that opens a container, a `;`, a quote or a bracket is claimed whole', () => {
  const cases = [
    {
      name: 'container with an inner close before the secret (item 1a)',
      text: `credentials={"a":{},"value":"${SECRET}"}`,
      summary: 'credentials=[redacted]',
    },
    {
      name: 'a bare value that begins with `;` (item 1b)',
      text: `password=;${SECRET}`,
      summary: 'password=[redacted]',
    },
    {
      name: 'material after a properly closed quoted value (item 1c)',
      text: `Authorization: "Bearer aa" ${SECRET}`,
      summary: 'Authorization: [redacted]',
    },
    { name: 'the shape that was already clean', text: `password=${SECRET}`, summary: 'password=[redacted]' },
    { name: 'an array container', text: `api_key=["a","b"] ${SECRET}`, summary: 'api_key=[redacted]' },
    {
      name: 'a credential object value in the JSON document form',
      text: `{"credentials":{"value":"${SECRET}"}}`,
      summary: '{"credentials":[redacted]',
    },
    // Round 7: the three shapes the previous round still truncated.
    { name: 'a bracket after the first value character', text: `password=x]${SECRET}`, summary: 'password=[redacted]' },
    { name: 'a closing brace before a quoted continuation', text: `password=x}"${SECRET}"`, summary: 'password=[redacted]' },
    { name: 'a semicolon and a quoted sibling', text: `password=x];"${SECRET}"`, summary: 'password=[redacted]' },
  ];
  for (const entry of cases) {
    const summary = summaryOf(entry.text);
    assert.equal(summary, entry.summary, `${entry.name}: ${entry.text}`);
    assert.equal(summary.includes(SECRET), false, `${entry.name} leaked the secret`);
    assert.equal(summary.includes('ReviewSecret'), false, `${entry.name} leaked a fragment of the secret`);
  }
  // Idempotence: the output of the rule is a fixed point, so a second projection
  // pass over a redacted record cannot eat what follows the marker.
  assert.equal(summaryOf(summaryOf(`credentials={"a":{},"value":"${SECRET}"}`)), 'credentials=[redacted]');
});

test('the accepted cost of the whole-remainder value is exactly this, and is documented', () => {
  // After a credential key and its separator, the remainder of the text is the
  // value. Balancing a container would make the value rule a JSON parser and
  // would have to decide where the *enclosing* document resumes, which is the
  // reopening this rule exists to avoid, so the cost is fixed here — container or
  // scalar alike —  so it cannot drift silently: the rest of the enclosing
  // document goes with the value.
  assert.equal(summaryOf(`{"password":{"a":1},"retry":3}`), '{"password":[redacted]');
  // A quoted scalar pays the same cost as of round 7: the closing quote, the
  // comma and the sibling field are gone, and the fragment no longer parses.
  assert.equal(summaryOf('{"password":"x","retry":3}'), '{"password":[redacted]');
  assert.throws(() => JSON.parse(summaryOf('{"password":"x","retry":3}')), SyntaxError,
    'the accepted cost: the fragment is not a JSON document');
});

test('the JSON, escaped-quote and multi-field shapes the earlier rounds fixed stay fixed', () => {
  const pinned = [
    ['{"password":"x","retry":3}', '{"password":[redacted]'],
    ['{"password":"it\'s","api_key":"k\'2"}', '{"password":[redacted]'],
    ['{\'password\':\'it"s-secret\'}', "{'password':[redacted]"],
    [String.raw`{\"password\":\"review-escaped-secret\"}`, String.raw`{\"password\":[redacted]`],
    [`token: k=v,"x":"y"`, 'token: [redacted]'],
    ['{"name":"o\'brien"}', '{"name":"o\'brien"}'],
    ['it\'s a plain message', 'it\'s a plain message'],
  ];
  for (const [text, expected] of pinned) {
    assert.equal(summaryOf(text), expected, text);
  }
});

// ---------------------------------------------------------------------------
// 2. The structured key predicate is at least as strong as the text one.
// ---------------------------------------------------------------------------

test('a credential spelling at the end of a structured key is redacted, whatever precedes it', () => {
  // The keys the independent review reproduced as leaks: normalizing them gives
  // `dbapikey` / `serviceaccesskey` / `xgoogapikey` / `vendorprivatekey`, none of
  // which is a whole-name match, while the text rule matched inside them.
  const keys = [
    'db_api_key', 'service_access_key', 'X-Goog-Api-Key', 'vendor_private_key',
    'my_service_api_key', 'gcp-private.key', 'tenant_session_token', 'a_secret_key',
  ];
  for (const key of keys) {
    assert.deepEqual(compacted({ [key]: SECRET }), { [key]: '[redacted]' }, `structured: ${key}`);
    // The two boundaries now agree for the same spelling, which is the property
    // the round was about: neither may be the weaker one.
    assert.equal(summaryOf(`${key}=${SECRET}`).includes(SECRET), false, `text: ${key}`);
  }
});

test('the keys that must stay readable still are', () => {
  // The list the review named as must-keep. An over-match here would empty the
  // evidence every promotion gate reads.
  const kept = ['note', 'value', 'reason', 'status', 'latency', 'errors', 'successRate', 'tokenizer'];
  for (const key of kept) {
    assert.deepEqual(compacted({ [key]: SECRET }), { [key]: SECRET }, `${key} must stay readable`);
  }
  // Ordinary telemetry rows keep their full shape, not only their keys.
  const ordinary = { note: 'the host was unreachable', retries: 3, status: 'failed', successRate: 0.5, tokenizer: 'cl100k' };
  assert.deepEqual(compacted(structuredClone(ordinary)), ordinary);
});

// ---------------------------------------------------------------------------
// 3. measure(): both list fields now cross the boundary, on every surface.
// ---------------------------------------------------------------------------

test('measure() projects sideEffects and orphanResources into the record, exp-*.md, the sidecar and the bridge', async (t) => {
  const h = await harness(t, 'measure-lists');
  const proposal = h.core.propose({ why: 'round5 lists', target: 'plugin:round5-lists', impactScope: ['test'], successMetrics: ['errors'] }, h.exec);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  const measured = await h.core.measure({
    experimentId: proposal.experimentId,
    observation: {
      solvesProblem: true,
      sideEffects: [`password=${SECRET}`, 'plugin:round5-plugin enabled'],
      orphanResources: [`token: ${SECRET}`, 'none'],
      metrics: { errors: 0 },
    },
  }, h.exec);

  // The stored observation.
  assert.deepEqual(measured.observation.sideEffects, ['password=[redacted]', 'plugin:round5-plugin enabled']);
  assert.deepEqual(measured.observation.orphanResources, ['token: [redacted]', 'none']);
  assert.equal(JSON.stringify(measured.observation).includes(SECRET), false, 'the returned observation carries no plaintext');
  const record = h.core.experiments.get(proposal.experimentId);
  assert.equal(JSON.stringify(record.observations).includes(SECRET), false, 'the stored observations carry no plaintext');

  // The evidence sidecar, through the production pair that writes it.
  const sidecarFile = await persistEvidenceSnapshot(h.paths.archiveDir, record.id, snapshotEvidenceFromRecord(record));
  const sidecar = await readText(sidecarFile);
  assert.equal(sidecar.includes(SECRET), false, 'the evidence sidecar carries no plaintext');
  assert.match(sidecar, /\[redacted\]/);

  // exp-*.md.
  const archiveFile = await h.core.archive(record, 'measured');
  const archive = await readText(archiveFile);
  assert.equal(archive.includes(SECRET), false, 'exp-*.md carries no plaintext');
  assert.match(archive, /plugin:round5-plugin enabled/, 'the credential-free entry is preserved');

  // The event bridge payload `measure()` emitted.
  const bridge = await readText(h.paths.eventBridgePath);
  assert.equal(bridge.includes(SECRET), false, 'the event bridge carries no plaintext');
  const event = bridgeEvent(bridge, 'measurement-completed');
  assert.deepEqual(event.measurement.sideEffects, ['password=[redacted]', 'plugin:round5-plugin enabled']);
  assert.deepEqual(event.measurement.orphanResources, ['token: [redacted]', 'none']);
});

test('a credential-free side-effect list is stored and rendered unchanged', async (t) => {
  const h = await harness(t, 'measure-lists-clean');
  const proposal = h.core.propose({ why: 'round5 clean lists', target: 'plugin:round5-clean', impactScope: ['test'], successMetrics: ['errors'] }, h.exec);
  await h.core.trial({ experimentId: proposal.experimentId, composition: COMPOSITION }, h.exec);
  const sideEffects = ['plugin:round5-plugin enabled', 'no new processes'];
  const orphanResources = ['none'];
  const measured = await h.core.measure({
    experimentId: proposal.experimentId,
    observation: { solvesProblem: true, sideEffects, orphanResources, metrics: { errors: 0 } },
  }, h.exec);
  assert.deepEqual(measured.observation.sideEffects, sideEffects);
  assert.deepEqual(measured.observation.orphanResources, orphanResources);
  const archive = await readText(await h.core.archive(h.core.experiments.get(proposal.experimentId), 'measured'));
  for (const entry of [...sideEffects, ...orphanResources]) {
    assert.equal(archive.includes(JSON.stringify(entry)), true, `the archive keeps \`${entry}\` verbatim`);
  }
});

// ---------------------------------------------------------------------------
// 4. The write paths that bypass the fixed renderer.
// ---------------------------------------------------------------------------

test('an explicit bridge payload measurement is projected at the bridge boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-round5-bridge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  const bridge = new EvolutionEventBridge({ file, key: 'b'.repeat(64) });

  const payload = {
    experimentId: 'exp-round5-bridge',
    measurement: {
      solvesProblem: true,
      sideEffects: [`password=${SECRET}`],
      orphanResources: [`token: ${SECRET}`],
      note: `api_key: ${SECRET}`,
      metrics: { errors: 0, access_token: SECRET },
    },
  };
  // Both entry points: `project()` is the boundary itself, `emit()` the writer.
  const projected = bridge.project('measurement-completed', {}, payload).measurement;
  assert.equal(JSON.stringify(projected).includes(SECRET), false, 'project() projects an explicit measurement');
  assert.deepEqual(projected.sideEffects, ['password=[redacted]']);
  assert.deepEqual(projected.orphanResources, ['token: [redacted]']);
  assert.equal(projected.note, 'api_key: [redacted]');
  assert.deepEqual(projected.metrics, { errors: 0, access_token: '[redacted]' });

  bridge.emit('measurement-completed', {}, payload);
  const text = await readText(file);
  assert.equal(text.includes(SECRET), false, 'the emitted envelope carries no plaintext');
  assert.deepEqual(bridgeEvent(text, 'measurement-completed').measurement.sideEffects, ['password=[redacted]']);

  // The preservation half: an ordinary measurement is not reshaped.
  const ordinary = { solvesProblem: true, sideEffects: ['none'], orphanResources: [], metrics: { errors: 0 } };
  assert.deepEqual(
    bridge.project('measurement-completed', {}, { experimentId: 'exp-round5-bridge-clean', measurement: ordinary }).measurement,
    ordinary,
  );
});

test('archive() projects what it interpolates, even when the record itself is unprojected', async (t) => {
  // `archive()` builds its own Markdown and does not call
  // `renderExperimentArchive`; the record it renders can come from
  // `hydrateRecordFromSnapshot`, i.e. from a durable record an older version
  // wrote before the capture-side projection existed. The renderer therefore
  // projects the fields it interpolates instead of assuming capture did.
  const h = await harness(t, 'archive-renderer');
  const record = {
    id: 'exp-round5-archive',
    ownerId: 'round5-owner',
    state: 'measured',
    proposal: {
      owner: 'round5-owner',
      why: `why: api_key: ${SECRET}`,
      target: 'plugin:round5-archive',
      impactScope: [`scope token: ${SECRET}`],
      successMetrics: [`metric password=${SECRET}`],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    targets: [],
    observations: [{ at: '2026-01-01T00:00:00.000Z', solvesProblem: true, sideEffects: [`password=${SECRET}`] }],
    latestObservation: { at: '2026-01-01T00:00:00.000Z', solvesProblem: true, note: `api_key: ${SECRET}` },
    runtimeRecovered: false,
  };
  const content = await readText(await h.core.archive(record, 'measured'));
  assert.equal(content.includes(SECRET), false, `archive() re-emitted unprojected text: ${content}`);
  assert.match(content, /- why: why: api_key: \[redacted\]/, 'the proposal line is projected');
  assert.match(content, /- impact: scope token: \[redacted\]/, 'the impact line is projected');
  assert.match(content, /- success metrics: metric password=\[redacted\]/, 'the success-metric line is projected');
  assert.match(content, /"note": "api_key: \[redacted\]"/, 'the latest measurement block is projected');
  assert.match(content, /"sideEffects": \[\n\s+"password=\[redacted\]"/, 'the observation block is projected');

  // The preservation half: a credential-free record renders exactly the lines it
  // rendered before this change.
  const clean = {
    id: 'exp-round5-archive-clean',
    ownerId: 'round5-owner',
    state: 'measured',
    proposal: {
      owner: 'round5-owner',
      why: 'plain why',
      target: 'plugin:clean',
      impactScope: ['a', 'b'],
      successMetrics: ['c', 'd'],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    targets: [],
    observations: [{ at: '2026-01-01T00:00:00.000Z', solvesProblem: true, sideEffects: ['none'] }],
    latestObservation: { at: '2026-01-01T00:00:00.000Z', solvesProblem: true, note: 'nothing to report' },
    runtimeRecovered: true,
  };
  const cleanContent = await readText(await h.core.archive(clean, 'measured'));
  assert.match(cleanContent, /- why: plain why/);
  assert.match(cleanContent, /- target: plugin:clean/);
  assert.match(cleanContent, /- impact: a, b/);
  assert.match(cleanContent, /- success metrics: c; d/);
  assert.equal(cleanContent.includes('[redacted]'), false, 'a credential-free record is not marked');
});

test('the promotion archive renderer projects its own interpolated fields', async (t) => {
  // The second raw renderer: `writeDurablePromotionUnlocked` writes the promoted
  // `exp-*.md` itself. The proposal it interpolates is the one it was handed.
  const h = await harness(t, 'promotion-renderer');
  const experiment = {
    id: 'exp-round5-promotion',
    ownerId: 'round5-owner',
    state: 'promoting',
    proposal: {
      owner: 'round5-owner',
      why: `why: api_key: ${SECRET}`,
      target: 'plugin:round5-promotion',
      impactScope: [`scope token: ${SECRET}`],
      successMetrics: ['errors'],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    runtimeRecovered: true,
    observations: [],
    latestObservation: { at: '2026-01-01T00:00:00.000Z', solvesProblem: true, note: `api_key: ${SECRET}` },
  };
  await writeDurablePromotion({
    experiment,
    paths: h.paths,
    packageInspection: { code: { host: HOST_CODE } },
  });
  const content = await readText(path.join(h.paths.archiveDir, `${experiment.id}.md`));
  assert.ok(content.length > 0, 'the promotion archive was written');
  assert.equal(content.includes(SECRET), false, `the promotion renderer re-emitted unprojected text: ${content}`);
  assert.match(content, /- why: why: api_key: \[redacted\]/);
  assert.match(content, /- impact: scope token: \[redacted\]/);
  assert.match(content, /"note": "api_key: \[redacted\]"/);
});

// ---------------------------------------------------------------------------
// 5. The two "non-throwing by construction" claims.
// ---------------------------------------------------------------------------

test('a throwing `code` getter does not abort the agent/error listener', async (t) => {
  const listeners = new Map();
  const observed = [];
  const warnings = [];
  const ctx = {
    dynamicCordisRunner: {},
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    on: (event, listener) => listeners.set(event, listener),
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  };
  const { apply } = await import('../lib/registration.js');
  const core = apply(ctx, { startupDrift: false, mode: 'autonomous', memory: {}, eventBridge: {} });
  core.observeAutonomous = async (observation) => { observed.push(observation); };

  const error = new Error('provider failed');
  Object.defineProperty(error, 'code', { enumerable: true, configurable: true, get() { throw new Error('code getter exploded'); } });
  // The listener is synchronous up to its fire-and-forget call: it must not throw,
  // and the DTO it produced must be the degraded one.
  listeners.get('agent/error')({ agent: { id: 'round5-agent' }, error });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(safeErrorDto(error, 'observation').errorCode, null, 'the DTO degrades instead of reading the code twice');
  assert.equal(observed.length, 1, 'the listener still reached the observer');
  assert.equal(observed[0].code, 'AGENT_ERROR', 'the observation falls back to the fixed code');
  assert.equal(observed[0].message, '[error details unavailable: the error object could not be read]');
  assert.deepEqual(warnings, [], 'no warning was needed: the listener never threw');
});

test('a Proxy or a throwing getter in a proof record is withheld, not rethrown', () => {
  // `safeErrorEvidence` walks proofs by `Object.entries`, which can throw from
  // `ownKeys`, `getOwnPropertyDescriptor` or `get`. The boundary is non-throwing
  // by construction, so an unreadable node is withheld with the existing marker.
  const hostileKeys = new Proxy({}, { ownKeys() { throw new TypeError('ownKeys exploded'); } });
  assert.deepEqual(snapshotEvidenceFromRecord({ cleanupProof: hostileKeys }).cleanupProof, '[compacted]');

  const throwingGetter = {};
  Object.defineProperty(throwingGetter, 'field', { enumerable: true, configurable: true, get() { throw new Error('getter exploded'); } });
  assert.deepEqual(snapshotEvidenceFromRecord({ recoveryProof: throwingGetter }).recoveryProof, '[compacted]');

  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.deepEqual(snapshotEvidenceFromRecord({ cleanupProof: revocable.proxy }).cleanupProof, '[compacted]');

  // A nested unreadable node is withheld on its own: the readable siblings of the
  // same proof are still persisted, which is why the guard wraps the read rather
  // than the whole node.
  const nested = snapshotEvidenceFromRecord({
    cleanupProof: { status: 'failed', error: hostileKeys, errors: ['timeout'] },
  }).cleanupProof;
  assert.deepEqual(nested, { status: 'failed', error: '[compacted]', errors: ['timeout'] });

  // And an ordinary proof is untouched by the guard.
  const ordinary = { status: 'recovered', stopOk: true, errors: [] };
  assert.deepEqual(snapshotEvidenceFromRecord({ cleanupProof: structuredClone(ordinary) }).cleanupProof, ordinary);
});
