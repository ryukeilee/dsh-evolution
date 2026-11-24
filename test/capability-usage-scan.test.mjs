// The usage projection feeds the disable recommendation and now also feeds the
// runtime audit, so two properties are pinned here: an incomplete scan must
// never look like "zero calls", and an attribution the log cannot prove must
// never be guessed into usage or verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256 } from '../lib/promoted-sharing.js';
import {
  createSessionCounter,
  readUsageProjection,
  summarizeCapabilityUsage,
  toolNamesFromSource,
} from '../lib/capability-usage.js';
import { readPublishedPluginReview } from '../lib/self-evolution-review.js';

const SCRIPT = fileURLToPath(new URL('../docs/audit/replay/capability-usage.mjs', import.meta.url));

test('the documented usage producer ships with the tarball', () => {
  const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const declared = manifest.files ?? [];
  assert.ok(declared.includes('docs/audit/replay/capability-usage.mjs'),
    'README instructs installed users to run the producer, so it must be distributed');
  assert.ok(declared.includes('lib'), 'the shared scanner implementation must be distributed too');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /from\s+['"](\.\.\/){3}lib\/capability-usage\.js['"]/,
    'the producer must import the shipped scanner through its relative package path');
});

const RECORD_ID = 'evolution-promoted-aaaaaaaaaaaa';
const SECOND_ID = 'evolution-promoted-bbbbbbbbbbbb';
const HOST = Object.freeze({ dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '2.0.3', node: process.version });

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'storages', 'evolution');
  fs.mkdirSync(path.join(dataRoot, 'shared-plugins'), { recursive: true });
  return { root, dataRoot, paths: { dataRoot, pluginRoot: path.join(dataRoot, 'promoted') } };
}

function writeRecord(env, { id = RECORD_ID, source, moduleUrl = null } = {}) {
  const pluginName = `dsh-${id}`;
  const modulePath = path.join(env.dataRoot, 'promoted', pluginName, 'lib', 'index.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.writeFileSync(modulePath, source);
  const manifest = `${JSON.stringify({ name: pluginName, version: '1.0.0' })}\n`;
  fs.writeFileSync(path.join(path.dirname(path.dirname(modulePath)), 'package.json'), manifest);
  const record = {
    schemaVersion: 1,
    id,
    experimentId: `experiment-${id.slice(-8)}`,
    pluginName,
    entry: 'lib/index.js',
    moduleUrl: moduleUrl ?? pathToFileURL(modulePath).href,
    sourceSha256: sha256(source),
    manifestSha256: sha256(manifest),
    publisherProfile: 'desktop',
    approvedProfiles: ['acp'],
    stable: {
      committedAt: '2026-01-01T00:00:00.000Z',
      decision: 'benefit',
      canary: { startupVerified: true, healthObservationWindow: 1, observations: 1 },
    },
    requiredServices: [],
    serviceMembers: {},
    requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include'],
    hostOnly: true,
    host: { dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '2.0.3', node: process.version },
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
  const indexFile = path.join(env.dataRoot, 'shared-plugins', 'published.json');
  let plugins = [];
  try { plugins = JSON.parse(fs.readFileSync(indexFile, 'utf8')).plugins ?? []; } catch { plugins = []; }
  plugins.push(record);
  fs.writeFileSync(indexFile, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plugins,
  })}\n`);
  return record;
}

function writeSession(root, name, lines, { corrupt = false, plain = false, fileName = null } = {}) {
  const dir = path.join(root, 'sessions', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName ?? (plain ? 'session.v4.jsonl' : 'session.v4.jsonl.zstd'));
  if (corrupt) fs.writeFileSync(file, Buffer.from('not a zstd frame'));
  else {
    const body = Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n'));
    fs.writeFileSync(file, plain ? body : zlib.zstdCompressSync(body));
  }
  return file;
}

function call(name, callId) {
  return { type: 'tool/call', data: { callId, name } };
}

function result(callId) {
  return { type: 'tool/result', data: { toolCallId: callId, message: { isError: false } } };
}

/** The official PTC row shape (`dsh-tools` / `dsh-session`): ids and name live in `data`. */
function ptcStart(name, subCallId, parentCallId) {
  return {
    type: 'tool/ptc-dispatch-start',
    seq: 7,
    data: { rootCallId: parentCallId, parentCallId, subCallId, name },
  };
}

function ptcDispatch(name, subCallId, parentCallId) {
  return {
    type: 'tool/ptc-dispatch',
    seq: 8,
    data: { rootCallId: parentCallId, parentCallId, subCallId, name, isError: false },
  };
}

function run(home, extra = []) {
  const args = [SCRIPT, '--home', home, ...extra];
  const out = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: out.status, projection: JSON.parse(out.stdout), stderr: out.stderr };
}

const WIDGET_SOURCE = [
  'const tool = harness.defineTool({ name: "widget_tool", description: "widget" });',
  'return { name: "widget-plugin", inject: ["tools"], apply(ctx) { harness.registerTool(ctx, tool); } };',
].join('\n');

test('the registered tool names come from definition sites, not schema fields', () => {
  const source = [
    'const schema = { name: "not_a_tool", type: "string" };',
    'const a = defineTool({ name: "alpha_tool", parameters: { name: { type: "string" } } });',
    'ctx.tools.register({ name: "beta-tool", description: "beta" });',
    'return { name: "plugin-name", inject: ["tools"] };',
  ].join('\n');
  assert.deepEqual(toolNamesFromSource(source).sort(), ['alpha_tool', 'beta-tool']);
  assert.deepEqual(toolNamesFromSource('const x = { name: "only_a_field" };'), []);
});

test('a complete scan reports the real counts', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'one', [call('widget_tool', 'c1'), call('bash', 'c2')]);
  const { status, projection } = run(env.root);
  assert.equal(status, 0);
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.records[RECORD_ID], {
    workflowInvocations: 1,
    verificationInvocations: 0,
    unattributedInvocations: 0,
    capabilityAssessment: 'unknown',
  });
});

test('a call is verification only while the promotion call that runs it is open', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  // Inside `evolution_probe`: the candidate is executed by the lifecycle call.
  writeSession(env.root, 'verification', [
    call('evolution_probe', 'p1'),
    call('widget_tool', 'c1'),
    result('c1'),
    result('p1'),
  ]);
  // A normal task that merely also used evolution_probe earlier is usage.
  writeSession(env.root, 'mixed', [
    call('evolution_probe', 'p2'),
    result('p2'),
    call('widget_tool', 'c2'),
    result('c2'),
  ]);
  const { projection } = run(env.root);
  assert.equal(projection.complete, true);
  assert.equal(projection.records[RECORD_ID].verificationInvocations, 1);
  assert.equal(projection.records[RECORD_ID].workflowInvocations, 1);
  assert.equal(projection.records[RECORD_ID].unattributedInvocations, 0);
});

test('a call under a lifecycle call that never returned is unattributed, not zero', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'truncated', [call('evolution_trial', 't1'), call('widget_tool', 'c1')]);
  const { projection } = run(env.root);
  assert.equal(projection.complete, true);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 1, capabilityAssessment: undefined },
  );
});

test('an unreadable session log makes the counts unknown, not zero', (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'one', [call('widget_tool', 'c1')]);
  writeSession(env.root, 'two', [], { corrupt: true });
  const { status, projection } = run(env.root);
  assert.equal(status, 3, 'an incomplete scan is reported as incomplete');
  assert.equal(projection.complete, false);
  assert.equal(projection.failures.undecompressableSessions.length, 1);
  assert.equal(projection.records[RECORD_ID].workflowInvocations, null);
  assert.equal(projection.records[RECORD_ID].verificationInvocations, null);
});

test('an unreadable plugin source invalidates only that record', (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  fs.rmSync(path.join(env.dataRoot, 'promoted', `dsh-${RECORD_ID}`, 'lib', 'index.js'));
  writeSession(env.root, 'one', [call('widget_tool', 'c1')]);
  const { status, projection } = run(env.root);
  assert.equal(status, 3, 'a per-record unknown is still an incomplete projection');
  assert.equal(projection.complete, true, 'session coverage itself is complete');
  assert.equal(projection.recordsComplete, false);
  assert.deepEqual(projection.failures.unreadableSources.map((row) => row.id), [RECORD_ID]);
  assert.equal(projection.records[RECORD_ID].workflowInvocations, null);
});

test('one record without registered tools does not distrust another record\'s measured zero', async (t) => {
  const env = scratch(t);
  // A context-policy plugin registers no tool: its call count cannot describe
  // its use, so that row stays unknown — but the scan did read its source, so it
  // must not make the whole projection look damaged.
  writeRecord(env, { id: SECOND_ID, source: 'return { name: "context-policy", apply() {} };\n' });
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'one', [call('bash', 'c1')]);
  const assessments = path.join(env.root, 'assessments.json');
  fs.writeFileSync(assessments, JSON.stringify({ [RECORD_ID]: 'self-contained' }));
  const { status, projection } = run(env.root, ['--write', '--assessments', assessments]);
  assert.equal(status, 0, 'a capability with no call surface is not a damaged scan');
  assert.equal(projection.complete, true);
  assert.equal(projection.recordsComplete, true);
  assert.deepEqual(projection.uncountableRecords, [{ id: SECOND_ID, reason: 'no-tool-surface' }]);
  assert.deepEqual(projection.failures, undefined, 'no failure is manufactured');
  assert.equal(projection.records[SECOND_ID].workflowInvocations, null, 'no tool means no call count');
  assert.equal(projection.records[SECOND_ID].measurement, 'no-tool-surface');
  assert.equal(projection.records[RECORD_ID].workflowInvocations, 0);
  assert.equal(projection.records[RECORD_ID].measurement, undefined);
  const loaded = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(loaded.usage.recordsComplete, true, 'an uncountable row is not an invalid row');
  assert.equal(loaded.usage.records[SECOND_ID].measurement, 'no-tool-surface');
  const review = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage: loaded.usage, usageStatus: 'ok' });
  const used = review.records.find((row) => row.id === RECORD_ID);
  const unmeasured = review.records.find((row) => row.id === SECOND_ID);
  assert.equal(used.value.invoked, false, 'a measured zero stays usable');
  assert.equal(used.value.workflowInvocations, 0);
  assert.equal(unmeasured.value.invoked, null);
  assert.equal(unmeasured.value.measurement, 'no-tool-surface');
  assert.equal(review.retirementCandidates.some((row) => row.recordId === SECOND_ID), false);
});

test('a tool name claimed by two records is ambiguous for both, never assigned to one', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeRecord(env, { id: SECOND_ID, source: WIDGET_SOURCE });
  writeSession(env.root, 'one', [call('widget_tool', 'c1')]);
  const { status, projection } = run(env.root);
  assert.equal(status, 3);
  assert.equal(projection.complete, true);
  assert.equal(projection.recordsComplete, false);
  assert.deepEqual(projection.failures.ambiguousToolNames, [{ tool: 'widget_tool', records: [RECORD_ID, SECOND_ID] }]);
  assert.equal(projection.records[RECORD_ID].workflowInvocations, null);
  assert.equal(projection.records[SECOND_ID].workflowInvocations, null);
});

test('--write persists the one projection the runtime audit reads', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'one', [call('widget_tool', 'c1')]);
  const assessments = path.join(env.root, 'assessments.json');
  fs.writeFileSync(assessments, JSON.stringify({ [RECORD_ID]: 'self-contained' }));
  const { status } = run(env.root, ['--write', '--assessments', assessments]);
  assert.equal(status, 0);
  const loaded = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.usage.complete, true);
  assert.equal(loaded.usage.stale, false);
  assert.equal(loaded.usage.records[RECORD_ID].workflowInvocations, 1);
  assert.equal(loaded.usage.records[RECORD_ID].capabilityAssessment, 'self-contained');
  assert.equal((fs.statSync(path.join(env.dataRoot, 'shared-plugins', 'usage.json')).mode & 0o777), 0o600);
});

test('the runtime audit reads the projection but an unattributable call blocks a retirement', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'truncated', [call('evolution_trial', 't1'), call('widget_tool', 'c1')]);
  const assessments = path.join(env.root, 'assessments.json');
  fs.writeFileSync(assessments, JSON.stringify({ [RECORD_ID]: 'self-contained' }));
  run(env.root, ['--write', '--assessments', assessments]);
  const loaded = await readUsageProjection({ dataRoot: env.dataRoot });
  const usage = loaded.usage;
  assert.equal(usage.records[RECORD_ID].unattributedInvocations, 1);
  const review = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage, usageStatus: 'ok' });
  assert.equal(review.records[0].value.invoked, null, 'one unresolved call is not a measured zero');
  assert.equal(review.retirementCandidates.length, 0);
  assert.equal(review.nextActions.some((row) => row.action === 'review-retirement'), false);
});

test('a stale projection cannot support "zero invocations" but still proves positive use', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  const sharedPlugins = path.join(env.dataRoot, 'shared-plugins');
  const write = (capturedAt, workflowInvocations) => fs.writeFileSync(path.join(sharedPlugins, 'usage.json'), JSON.stringify({
    kind: 'dsh-evolution-capability-usage',
    schemaVersion: 1,
    source: 'session-evidence',
    complete: true,
    capturedAt,
    records: { [RECORD_ID]: { workflowInvocations, verificationInvocations: 0, unattributedInvocations: 0, capabilityAssessment: 'self-contained' } },
  }));
  write('2020-01-01T00:00:00.000Z', 0);
  const stale = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(stale.usage.stale, true);
  const staleReview = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage: stale.usage, usageStatus: 'ok' });
  assert.equal(staleReview.records[0].value.invoked, null);
  assert.equal(staleReview.retirementCandidates.length, 0);
  assert.match(staleReview.records[0].value.reasons.join(' '), /incomplete or stale/);

  write('2020-01-01T00:00:00.000Z', 3);
  const usedStale = await readUsageProjection({ dataRoot: env.dataRoot });
  const usedReview = await readPublishedPluginReview({ paths: env.paths, host: HOST, usage: usedStale.usage, usageStatus: 'ok' });
  assert.equal(usedReview.records[0].value.invoked, true, 'a call that happened is still a fact');
  assert.equal(usedReview.records[0].value.tier, 'in-use');
});

test('a damaged or oversized projection is reported, never guessed around', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  const file = path.join(env.dataRoot, 'shared-plugins', 'usage.json');
  assert.equal((await readUsageProjection({ dataRoot: env.dataRoot })).status, 'absent');
  fs.writeFileSync(file, '{not json');
  assert.equal((await readUsageProjection({ dataRoot: env.dataRoot })).status, 'invalid');
  fs.writeFileSync(file, JSON.stringify({ kind: 'something-else', records: {} }));
  assert.equal((await readUsageProjection({ dataRoot: env.dataRoot })).evidence.reason, 'kind');
  fs.writeFileSync(file, 'x'.repeat(600 * 1024));
  assert.equal((await readUsageProjection({ dataRoot: env.dataRoot })).evidence.reason, 'size');
  fs.writeFileSync(file, JSON.stringify({
    kind: 'dsh-evolution-capability-usage',
    schemaVersion: 1,
    source: 'session-evidence',
    complete: true,
    capturedAt: new Date().toISOString(),
    records: { [RECORD_ID]: { workflowInvocations: 'many', verificationInvocations: 0, capabilityAssessment: 'self-contained' } },
  }));
  const loaded = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(loaded.usage.records[RECORD_ID].workflowInvocations, null);
  assert.equal(loaded.usage.recordsComplete, false, 'an unusable row makes that row unknown');
  assert.equal(loaded.usage.complete, true, 'the session coverage itself is unaffected');
});

test('an unreadable session file is reported, not thrown', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  const dir = path.join(env.root, 'sessions', 'dangling');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(dir, 'missing-target'), path.join(dir, 'session.v4.jsonl.zstd'));
  writeSession(env.root, 'one', [call('widget_tool', 'c1')]);
  const { status, projection } = run(env.root);
  assert.equal(status, 3);
  assert.equal(projection.complete, false);
  assert.deepEqual(projection.failures.unreadableSessions, [{ session: 'dangling' }]);
  assert.equal(projection.records[RECORD_ID].workflowInvocations, null);
});

test('an older projection without the unattributed bucket is still readable', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  const file = path.join(env.dataRoot, 'shared-plugins', 'usage.json');
  fs.writeFileSync(file, JSON.stringify({
    source: 'session-evidence',
    complete: true,
    capturedAt: new Date().toISOString(),
    records: { [RECORD_ID]: { workflowInvocations: 0, verificationInvocations: 2, capabilityAssessment: 'self-contained' } },
  }));
  const loaded = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.usage.records[RECORD_ID].unattributedInvocations, 0);
  assert.equal(loaded.usage.records[RECORD_ID].workflowInvocations, 0);
  // A row that omits a required count is unknown, not zero.
  fs.writeFileSync(file, JSON.stringify({
    source: 'session-evidence',
    complete: true,
    capturedAt: new Date().toISOString(),
    records: { [RECORD_ID]: { verificationInvocations: 0, capabilityAssessment: 'self-contained' } },
  }));
  const partial = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(partial.status, 'ok');
  assert.equal(partial.usage.records[RECORD_ID].workflowInvocations, null);
  assert.equal(partial.usage.recordsComplete, false);
});

test('the README-documented usage projection producer ships in the package', t => {
  // `evolution_plan` and the ACP audit read `<dataRoot>/shared-plugins/usage.json`,
  // but an installed user can only produce that file with this CLI. If the
  // allow-list drops it, every production record stays `usage-unknown` and the
  // review-retirement action is unreachable outside this repository.
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const producer = 'docs/audit/replay/capability-usage.mjs';
  assert.ok(pkg.files.includes(producer), 'the producer referenced by README must be distributed');
  assert.ok(fs.existsSync(SCRIPT), 'the referenced producer must exist at that path');
});

test('the scanner output is reproducible directly, without the CLI', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'one', [call('evolution_probe', 'p1'), call('widget_tool', 'c1'), result('c1'), result('p1')]);
  const projection = await summarizeCapabilityUsage({
    dataRoot: env.dataRoot,
    sessionsRoot: path.join(env.root, 'sessions'),
    now: Date.parse('2026-11-23T00:00:00.000Z'),
  });
  assert.equal(projection.capturedAt, '2026-11-23T00:00:00.000Z');
  assert.equal(projection.complete, true);
  assert.equal(projection.records[RECORD_ID].verificationInvocations, 1);
  assert.equal(projection.scannedSessions, 1);
  assert.equal(projection.scannedToolCalls, 2);
});

// 2026-11-24 reliability round: the ACP coordination tool is not a candidate
// execution lifecycle. Its read-only audit/status calls must never turn a real
// published-tool usage into verification traffic.
test('evolution_desktop coordination does not mark a published call as verification', () => {
  const counter = createSessionCounter(new Set(['mytool']));
  assert.equal(counter.call({ type: 'tool/call', data: { name: 'mytool', callId: 't1' } }), 'workflow');
  assert.equal(counter.call({ type: 'tool/call', data: { name: 'evolution_desktop', callId: 'e1' } }), 'ignored');
  assert.equal(counter.call({ type: 'tool/call', data: { name: 'mytool', callId: 't2' } }), 'workflow');
  counter.call({ type: 'tool/result', data: { toolCallId: 'e1' } });
  counter.call({ type: 'tool/result', data: { toolCallId: 't2' } });
  counter.call({ type: 'tool/result', data: { toolCallId: 't1' } });
  assert.deepEqual(Object.fromEntries(counter.finish()), {
    mytool: { workflow: 2, verification: 0, unattributed: 0 },
  });
});

test('a real promotion lifecycle call still marks an overlapping published call as verification', () => {
  const counter = createSessionCounter(new Set(['mytool']));
  counter.call({ type: 'tool/call', data: { name: 'evolution_trial', callId: 'life1' } });
  counter.call({ type: 'tool/call', data: { name: 'mytool', callId: 't1' } });
  counter.call({ type: 'tool/result', data: { toolCallId: 't1' } });
  counter.call({ type: 'tool/result', data: { toolCallId: 'life1' } });
  assert.deepEqual(Object.fromEntries(counter.finish()), {
    mytool: { workflow: 0, verification: 1, unattributed: 0 },
  });
});

// 2026-11-25 PTC usage attribution round. The counter contract is pinned at
// unit level first: native rows keep their old returns, a start only reserves
// a dispatch, a completed dispatch is counted once, and a start with no final
// dispatch is still an invocation at finish.
test('createSessionCounter counts native calls and PTC dispatches exactly once', () => {
  const counter = createSessionCounter(new Set(['mytool']));
  assert.equal(counter.call(call('mytool', 'native1')), 'workflow');
  assert.equal(counter.call(call('evolution_probe', 'p1')), 'lifecycle');
  assert.equal(counter.call(call('mytool', 'native2')), 'pending');
  assert.equal(counter.call(result('native2')), 'result');
  assert.equal(counter.call(result('p1')), 'result');
  assert.equal(counter.call(call('run_code', 'rc1')), 'ignored');
  assert.equal(counter.call(ptcStart('mytool', 'rc1:ptc:1', 'rc1')), 'ptc-start');
  assert.equal(counter.call(ptcDispatch('mytool', 'rc1:ptc:1', 'rc1')), 'workflow');
  assert.equal(counter.call(call('evolution_trial', 't1')), 'lifecycle');
  assert.equal(counter.call(ptcStart('mytool', 'rc1:ptc:2', 'rc1')), 'ptc-start');
  assert.equal(counter.call(ptcDispatch('mytool', 'rc1:ptc:2', 'rc1')), 'pending');
  // This start never completes: it is still a proven invocation at finish.
  assert.equal(counter.call(ptcStart('mytool', 'rc1:ptc:3', 'rc1')), 'ptc-start');
  assert.equal(counter.call(result('t1')), 'result');
  assert.deepEqual(Object.fromEntries(counter.finish()), {
    mytool: { workflow: 2, verification: 2, unattributed: 1 },
  });
});

test('a model run_code PTC dispatch of a published tool is workflow usage', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'ptc-workflow', [
    call('run_code', 'rc1'),
    ptcStart('widget_tool', 'rc1:ptc:1', 'rc1'),
    ptcDispatch('widget_tool', 'rc1:ptc:1', 'rc1'),
  ]);
  const { status, projection } = run(env.root);
  assert.equal(status, 0);
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.records[RECORD_ID], {
    workflowInvocations: 1,
    verificationInvocations: 0,
    unattributedInvocations: 0,
    capabilityAssessment: 'unknown',
  });
  assert.equal(projection.scannedSessions, 1);
  // Native run_code row plus the completed PTC dispatch; the start is not a call.
  assert.equal(projection.scannedToolCalls, 2);
});

test('a PTC dispatch under an open evolution_probe is verification', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'ptc-verification', [
    call('evolution_probe', 'p1'),
    call('run_code', 'rc1'),
    ptcStart('widget_tool', 'rc1:ptc:1', 'rc1'),
    ptcDispatch('widget_tool', 'rc1:ptc:1', 'rc1'),
    result('rc1'),
    result('p1'),
  ]);
  const { projection } = run(env.root);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 0, verificationInvocations: 1, unattributedInvocations: 0, capabilityAssessment: undefined },
  );
});

test('a PTC dispatch under a lifecycle call that never returns is unattributed', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'ptc-truncated', [
    call('evolution_trial', 't1'),
    call('run_code', 'rc1'),
    ptcStart('widget_tool', 'rc1:ptc:1', 'rc1'),
    ptcDispatch('widget_tool', 'rc1:ptc:1', 'rc1'),
  ]);
  const { projection } = run(env.root);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 1, capabilityAssessment: undefined },
  );
});

test('a host-driven PTC dispatch with no native parent call is unattributed', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'ptc-host-driven', [
    ptcStart('widget_tool', 'host:ptc:1', 'host-root'),
    ptcDispatch('widget_tool', 'host:ptc:1', 'host-root'),
  ]);
  const { projection } = run(env.root);
  assert.equal(projection.complete, true);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 1, capabilityAssessment: undefined },
  );
});

test('a dangling PTC dispatch-start is unattributed, never a measured zero', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'ptc-dangling', [
    call('run_code', 'rc1'),
    ptcStart('widget_tool', 'rc1:ptc:1', 'rc1'),
  ]);
  const { projection } = run(env.root);
  assert.equal(projection.complete, true);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 1, capabilityAssessment: undefined },
  );
  assert.equal(projection.scannedToolCalls, 1, 'a start is not a completed call');
});

test('a non-published PTC dispatch is ignored', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'ptc-unpublished', [
    call('run_code', 'rc1'),
    ptcStart('bash', 'rc1:ptc:1', 'rc1'),
    ptcDispatch('bash', 'rc1:ptc:1', 'rc1'),
  ]);
  const { status, projection } = run(env.root);
  assert.equal(status, 0);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 0, capabilityAssessment: undefined },
  );
});

test('ignored PTC rows do not change the native call path', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'native', [
    call('evolution_probe', 'p1'),
    call('widget_tool', 'c1'),
    result('c1'),
    result('p1'),
    call('widget_tool', 'c2'),
    ptcStart('bash', 'rc1:ptc:1', 'rc1'),
    ptcDispatch('bash', 'rc1:ptc:1', 'rc1'),
  ]);
  const { projection } = run(env.root);
  assert.deepEqual(
    { ...projection.records[RECORD_ID], capabilityAssessment: undefined },
    { workflowInvocations: 1, verificationInvocations: 1, unattributedInvocations: 0, capabilityAssessment: undefined },
  );
});

test('a plaintext v4 session counts a real call like the zstd encoding', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'plain', [call('widget_tool', 'c1')], { plain: true });
  const { status, projection } = run(env.root);
  assert.equal(status, 0);
  assert.equal(projection.complete, true);
  assert.equal(projection.scannedSessions, 1);
  assert.equal(projection.scannedToolCalls, 1);
  assert.equal(projection.records[RECORD_ID].workflowInvocations, 1);
});

test('other canonical session generations are reported unscanned, never a measured zero', async (t) => {
  const env = scratch(t);
  writeRecord(env, { source: WIDGET_SOURCE });
  writeSession(env.root, 'current', [call('widget_tool', 'c1')]);
  writeSession(env.root, 'legacy-plain', [call('widget_tool', 'old1')], { plain: true, fileName: 'session.v3.jsonl' });
  writeSession(env.root, 'legacy-zstd', [call('widget_tool', 'old2')], { fileName: 'session.v3.jsonl.zstd' });
  writeSession(env.root, 'unversioned', [call('widget_tool', 'old3')], { plain: true, fileName: 'session.jsonl' });
  const { status, projection } = run(env.root);
  assert.equal(status, 3);
  assert.equal(projection.complete, false);
  assert.equal(projection.recordsComplete, false);
  assert.deepEqual(projection.failures.unsupportedSessionFormats, [
    { session: 'legacy-plain', file: 'session.v3.jsonl' },
    { session: 'legacy-zstd', file: 'session.v3.jsonl.zstd' },
    { session: 'unversioned', file: 'session.jsonl' },
  ]);
  assert.equal(projection.scannedSessions, 1, 'only the current generation is parsed');
  assert.equal(projection.records[RECORD_ID].workflowInvocations, null);
  assert.equal(projection.records[RECORD_ID].verificationInvocations, null);
  assert.equal(projection.records[RECORD_ID].unattributedInvocations, null);
});
