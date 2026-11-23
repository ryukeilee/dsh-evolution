#!/usr/bin/env node
/**
 * Measured evidence for the usage-evidence wiring:
 *
 *   - entry-level A/B: mount the real ACP `evolution_desktop` audit against one
 *     fixture (published record + consumer row + persisted usage projection)
 *     using a baseline tree (`--baseline <tree>`) and this tree, and report the
 *     value verdict, the usage provenance and the ordered next actions;
 *   - audit cost: median wall time of the same audit with and without the
 *     projection present (the only runtime change is one bounded file read);
 *   - scan cost: wall time, peak RSS delta and bytes for the explicit offline
 *     scanner over a synthetic session tree.
 *
 * Synthetic data only: every path is under a fresh os.tmpdir() directory and no
 * real session, profile or data root is read.
 *
 * Usage:
 *   node scripts/benchmarks/usage-audit-wiring.mjs [--baseline <tree>] [--sessions 200] [--lines 2000] [--rounds 7]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const RECORD_ID = 'evolution-promoted-aaaaaaaaaaaa';
const HOST = { dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '2.0.3', node: process.version };

function hostDigest(host) {
  return sha256(JSON.stringify({ dsh: host?.dsh ?? null, cordis: host?.cordis ?? null, include: host?.include ?? null, node: host?.node ?? null }));
}

function fixture(root) {
  const dataRoot = path.join(root, 'storages', 'evolution');
  const pluginName = `dsh-${RECORD_ID}`;
  const modulePath = path.join(dataRoot, 'promoted', pluginName, 'lib', 'index.js');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  const source = 'const tool = harness.defineTool({ name: "widget_tool", description: "widget" });\n';
  fs.writeFileSync(modulePath, source);
  const manifest = `${JSON.stringify({ name: pluginName, version: '1.0.0' })}\n`;
  fs.writeFileSync(path.join(path.dirname(path.dirname(modulePath)), 'package.json'), manifest);
  fs.mkdirSync(path.join(dataRoot, 'shared-plugins', 'consumers'), { recursive: true });
  const updatedAt = '2026-11-20T00:00:00.000Z';
  const record = {
    schemaVersion: 1,
    id: RECORD_ID,
    experimentId: 'experiment-usage-fixture',
    pluginName,
    entry: 'lib/index.js',
    moduleUrl: pathToFileURL(modulePath).href,
    sourceSha256: sha256(source),
    manifestSha256: sha256(manifest),
    publisherProfile: 'desktop',
    approvedProfiles: ['acp'],
    stable: { committedAt: updatedAt, decision: 'benefit', canary: { startupVerified: true, healthObservationWindow: 1, observations: 1 } },
    requiredServices: [],
    serviceMembers: {},
    requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include'],
    hostOnly: true,
    host: HOST,
    publishedAt: updatedAt,
  };
  fs.writeFileSync(path.join(dataRoot, 'shared-plugins', 'published.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt,
    plugins: [record],
  })}\n`);
  fs.writeFileSync(path.join(dataRoot, 'shared-plugins', 'consumers', 'acp.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'dsh-evolution-promoted-consumer',
    profile: 'acp',
    updatedAt,
    host: HOST,
    observedIndexUpdatedAt: updatedAt,
    compositionPath: path.join(dataRoot, 'shared-plugins', 'consumers', 'acp.cordis.yml'),
    plugins: [{ id: RECORD_ID, status: 'active', reason: null, hostDigest: hostDigest(HOST) }],
  })}\n`);
  return { dataRoot, record };
}

function writeUsage(dataRoot, { workflowInvocations, capabilityAssessment = 'self-contained' }) {
  fs.writeFileSync(path.join(dataRoot, 'shared-plugins', 'usage.json'), `${JSON.stringify({
    kind: 'dsh-evolution-capability-usage',
    schemaVersion: 1,
    source: 'session-evidence',
    complete: true,
    capturedAt: new Date().toISOString(),
    records: { [RECORD_ID]: { workflowInvocations, verificationInvocations: 0, unattributedInvocations: 0, capabilityAssessment } },
  })}\n`);
}

function mount(clientModule, home) {
  const tools = new Map();
  const ctx = {
    // No live package service: the same fallback the review documents.
    get: () => null,
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    systemPrompt: { section: () => {} },
  };
  clientModule.apply(ctx, {
    dshHome: home,
    platform: 'darwin',
    spawn: () => { throw new Error('the benchmark never launches Desktop'); },
    launchPollMs: 1,
    launchTimeoutMs: 1,
    statePollMs: 1,
    delegateTimeoutMs: 1000,
  });
  return tools.get(clientModule.TOOL_NAME);
}

async function auditSummary(clientModule, home, rounds) {
  const tool = mount(clientModule, home);
  const samples = [];
  let last;
  for (let index = 0; index < rounds; index += 1) {
    const started = process.hrtime.bigint();
    last = await tool.execute({ action: 'audit' }, {});
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  const [record] = last.stable.records;
  return {
    medianMs: Math.round(samples[Math.floor(samples.length / 2)] * 1000) / 1000,
    status: last.stable.status,
    usageEvidence: last.stable.usageEvidence,
    tier: record?.value?.tier ?? null,
    invoked: record?.value?.invoked ?? null,
    workflowInvocations: record?.value?.workflowInvocations ?? null,
    retirementCandidates: last.stable.retirementCandidates.length,
    nextActions: last.selfEvolution.nextActions.map((row) => row.action),
    primary: last.selfEvolution.primary,
  };
}

async function scanCost({ sessions, lines, rounds }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scan-bench-'));
  try {
    const { dataRoot } = fixture(root);
    const sessionsRoot = path.join(root, 'sessions');
    const lifecycle = 20;
    for (let session = 0; session < sessions; session += 1) {
      const dir = path.join(sessionsRoot, `s${session}`);
      fs.mkdirSync(dir, { recursive: true });
      const rows = [];
      let openId = null;
      for (let index = 0; index < lines; index += 1) {
        const callId = `c${session}-${index}`;
        if (index % lifecycle === 0) {
          openId = `l${session}-${index}`;
          rows.push({ type: 'tool/call', data: { callId: openId, name: 'evolution_probe' } });
        } else if (index % lifecycle === lifecycle - 1 && openId !== null) {
          rows.push({ type: 'tool/result', data: { toolCallId: openId, message: { isError: false } } });
          openId = null;
        } else if (index % 3 === 0) rows.push({ type: 'tool/call', data: { callId, name: 'widget_tool' } });
        else rows.push({ type: 'tool/call', data: { callId, name: 'bash' } });
      }
      fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))));
    }
    const module = await import('../../lib/capability-usage.js');
    const rssBefore = process.memoryUsage().rss;
    const samples = [];
    let last;
    for (let index = 0; index < rounds; index += 1) {
      const started = process.hrtime.bigint();
      last = await module.summarizeCapabilityUsage({ dataRoot, sessionsRoot });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    const rssAfter = process.memoryUsage().rss;
    samples.sort((left, right) => left - right);
    return {
      sessions,
      linesPerSession: lines,
      scannedSessions: last.scannedSessions,
      scannedToolCalls: last.scannedToolCalls,
      complete: last.complete,
      workflowInvocations: last.records[RECORD_ID]?.workflowInvocations ?? null,
      verificationInvocations: last.records[RECORD_ID]?.verificationInvocations ?? null,
      medianMs: Math.round(samples[Math.floor(samples.length / 2)] * 1000) / 1000,
      bytesOnDisk: fs.readdirSync(sessionsRoot).reduce((total, name) =>
        total + fs.statSync(path.join(sessionsRoot, name, 'session.v4.jsonl.zstd')).size, 0),
      rssDeltaMiB: Math.round(((rssAfter - rssBefore) / (1024 * 1024)) * 10) / 10,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function directReview(tree, paths, usage) {
  const module = await import(pathToFileURL(path.join(tree, 'lib', 'self-evolution-review.js')).href);
  const review = await module.readPublishedPluginReview({ paths, host: HOST, usage });
  const [record] = review.records;
  return {
    tier: record?.value?.tier ?? null,
    invoked: record?.value?.invoked ?? null,
    workflowInvocations: record?.value?.workflowInvocations ?? null,
    retirementCandidates: review.retirementCandidates.length,
    nextActions: review.nextActions.map((row) => row.action),
  };
}

const rounds = Number(arg('--rounds', '7'));
const baselineTree = arg('--baseline', null);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-audit-bench-'));
try {
  const { dataRoot } = fixture(root);
  const current = await import('../../lib/desktop-task-client.js');
  const withoutProjection = await auditSummary(current, root, rounds);
  writeUsage(dataRoot, { workflowInvocations: 0 });
  const withZeroUsage = await auditSummary(current, root, rounds);
  writeUsage(dataRoot, { workflowInvocations: 3 });
  const withUsage = await auditSummary(current, root, rounds);
  let baseline = null;
  let reviewBaseline = null;
  let reviewBaselineZero = null;
  if (baselineTree) {
    const module = await import(pathToFileURL(path.join(path.resolve(baselineTree), 'lib', 'desktop-task-client.js')).href);
    writeUsage(dataRoot, { workflowInvocations: 3 });
    baseline = await auditSummary(module, root, rounds);
    const loadedForBaseline = await (await import('../../lib/capability-usage.js')).readUsageProjection({ dataRoot });
    reviewBaseline = await directReview(path.resolve(baselineTree), { dataRoot, pluginRoot: path.join(dataRoot, 'promoted') }, loadedForBaseline.usage);
    writeUsage(dataRoot, { workflowInvocations: 0 });
    const loadedZero = await (await import('../../lib/capability-usage.js')).readUsageProjection({ dataRoot });
    reviewBaselineZero = await directReview(path.resolve(baselineTree), { dataRoot, pluginRoot: path.join(dataRoot, 'promoted') }, loadedZero.usage);
  }
  writeUsage(dataRoot, { workflowInvocations: 0 });
  const loadedZero = await (await import('../../lib/capability-usage.js')).readUsageProjection({ dataRoot });
  const reviewCurrentZero = await directReview(new URL('../../', import.meta.url).pathname, { dataRoot, pluginRoot: path.join(dataRoot, 'promoted') }, loadedZero.usage);
  writeUsage(dataRoot, { workflowInvocations: 3 });
  const loaded = await (await import('../../lib/capability-usage.js')).readUsageProjection({ dataRoot });
  const reviewCurrent = await directReview(new URL('../../', import.meta.url).pathname, { dataRoot, pluginRoot: path.join(dataRoot, 'promoted') }, loaded.usage);
  const scan = await scanCost({ sessions: Number(arg('--sessions', '200')), lines: Number(arg('--lines', '2000')), rounds: Math.min(rounds, 3) });
  console.log(JSON.stringify({
    identity: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      baselineTree: baselineTree ? path.resolve(baselineTree) : null,
      currentLib: sha256(fs.readFileSync(new URL('../../lib/desktop-task-client.js', import.meta.url))),
    },
    audit: { withoutProjection, withZeroUsage, withUsage, baseline },
    review: { baseline: reviewBaseline, baselineZeroUsage: reviewBaselineZero, current: reviewCurrent, currentZeroUsage: reviewCurrentZero },
    scan,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
