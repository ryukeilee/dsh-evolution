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
  readUsageProjection,
  summarizeCapabilityUsage,
  toolNamesFromSource,
} from '../lib/capability-usage.js';
import { readPublishedPluginReview } from '../lib/self-evolution-review.js';

const SCRIPT = fileURLToPath(new URL('../docs/audit/replay/capability-usage.mjs', import.meta.url));

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

function writeSession(root, name, lines, { corrupt = false } = {}) {
  const dir = path.join(root, 'sessions', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  if (corrupt) fs.writeFileSync(file, Buffer.from('not a zstd frame'));
  else fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n'))));
  return file;
}

function call(name, callId) {
  return { type: 'tool/call', data: { callId, name } };
}

function result(callId) {
  return { type: 'tool/result', data: { toolCallId: callId, message: { isError: false } } };
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
