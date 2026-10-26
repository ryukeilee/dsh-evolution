#!/usr/bin/env node
/**
 * Run with:
 *   /opt/homebrew/opt/node@22/bin/node --max-old-space-size=4096 scripts/benchmarks/capacity-reclaim.mjs --all --json
 * If that Node path is unavailable, use `node` with the same flags.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { inspectArchiveIntegrity } from '../../lib/archive-stage.js';
import { openDomainStorage } from '../../lib/domain-storage.js';
import {
  EvolutionEventBridge,
  externalizeEventBridgeEvidence,
  readEventBridgeEvidence,
  readEvidenceSnapshot,
} from '../../lib/orchestrator.js';

const DEFAULT_SIZES = [200, 2000, 20000];
const KEY = 'b'.repeat(64);
const WRITER = 'dsh-evolution-orchestrator';
const FIXED_AT = '2026-10-26T00:00:00.000Z';
const RETAIN_RECORDS = 1;
const temporaryHomes = new Set();

function cleanupTemporaryHomes() {
  for (const home of temporaryHomes) {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  temporaryHomes.clear();
}
process.once('exit', cleanupTemporaryHomes);

function usage() {
  return [
    'Usage: node scripts/benchmarks/capacity-reclaim.mjs [--sizes 200,2000,20000] [--json] [--all] [--help]',
    '  --sizes  Comma-separated positive record counts (default: 200,2000,20000)',
    '  --all    Run all default sizes (the default when --sizes is omitted)',
    '  --json   Write one JSON object to stdout',
    '  --help   Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  let sizes = null;
  let json = false;
  let all = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') { help = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--all') { all = true; continue; }
    if (arg === '--sizes') {
      if (sizes !== null) throw new Error('--sizes may only be supplied once');
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--sizes requires comma-separated positive integers');
      sizes = value.split(',').map(part => {
        if (!/^[1-9][0-9]*$/.test(part)) throw new Error(`Invalid --sizes value: ${part}`);
        const size = Number(part);
        if (!Number.isSafeInteger(size)) throw new Error(`--sizes value is outside the safe integer range: ${part}`);
        return size;
      });
      if (sizes.length === 0) throw new Error('--sizes must contain at least one value');
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (all && sizes !== null) throw new Error('--all cannot be combined with --sizes');
  return { help, json, sizes: sizes ?? DEFAULT_SIZES };
}

function contextFor(home, backend) {
  const listeners = new Map();
  const ctx = {
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    on(name, listener) {
      const registered = listeners.get(name) ?? [];
      registered.push(listener);
      listeners.set(name, registered);
      return () => {
        const position = registered.indexOf(listener);
        if (position >= 0) registered.splice(position, 1);
      };
    },
    logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } },
    effect() {},
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  return ctx;
}

function configFor(home) {
  const archiveDir = path.join(home, 'archive');
  return {
    presetDir: home,
    archiveDir,
    eventBridgePath: path.join(home, 'execution-events.jsonl'),
    eventBridgeKey: KEY,
    eventBridgeWriter: WRITER,
    externalizeEventEvidence: entries => externalizeEventBridgeEvidence({ archiveDir }, entries),
  };
}

function walkFiles(root, visit, relative = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, childRelative);
    if (entry.isDirectory()) walkFiles(root, visit, childRelative);
    else if (entry.isFile()) visit(absolute, childRelative);
    else if (entry.isSymbolicLink()) visit(absolute, childRelative);
  }
}

function fileSize(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() || stat.isSymbolicLink() ? stat.size : 0;
  } catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
}

function countJsonlRows(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0) return 0;
  let newlines = 0;
  for (const byte of bytes) if (byte === 0x0a) newlines += 1;
  return newlines + (bytes.at(-1) === 0x0a ? 0 : 1);
}

function archiveSegmentFiles(home) {
  const root = path.join(home, 'dockyard');
  const files = [];
  walkFiles(root, (absolute, relative) => {
    if (/(?:^|[\\/])state\.json\.[A-Za-z]+-archive\.jsonl\.segments[\\/]segment-[0-9]+\.jsonl$/.test(relative)) files.push(absolute);
  });
  return files.sort();
}

function archiveJsonlStats(home) {
  const root = path.join(home, 'dockyard');
  let rows = 0;
  walkFiles(root, (absolute, relative) => {
    const isArchive = /(?:^|[\\/])state\.json\.[A-Za-z]+-archive\.jsonl$/.test(relative);
    const isSegment = /(?:^|[\\/])state\.json\.[A-Za-z]+-archive\.jsonl\.segments[\\/]segment-[0-9]+\.jsonl$/.test(relative);
    if (isArchive || isSegment) rows += countJsonlRows(absolute);
  });
  return rows;
}

function domainGlobal(ctx) {
  return ctx.storageDomain.get('evolution_domain').global.get();
}

function snapshot(home, ctx) {
  const categories = { dockyard: 0, executionEvents: 0, official: 0, checkpoint: 0, other: 0 };
  walkFiles(home, (absolute, relative) => {
    const normalized = relative.split(path.sep).join('/');
    const size = fileSize(absolute);
    if (normalized === 'execution-events.jsonl') categories.executionEvents += size;
    else if (normalized === 'event-log.checkpoint.json') categories.checkpoint += size;
    else if (normalized.startsWith('dockyard/')) categories.dockyard += size;
    else if (normalized.startsWith('official/')) categories.official += size;
    else categories.other += size;
  });
  const domain = domainGlobal(ctx);
  return {
    totalBytes: Object.values(categories).reduce((sum, value) => sum + value, 0),
    categories,
    appliedMarkers: Object.keys(domain.applied ?? {}).length,
    dockyardStateJsonBytes: fileSize(path.join(home, 'dockyard', 'state.json')),
    officialDomainJsonBytes: fileSize(path.join(home, 'official', 'evolution_domain.json')),
    segmentFiles: archiveSegmentFiles(home).length,
    archiveJsonlRows: archiveJsonlStats(home),
  };
}

function categoryDelta(before, after) {
  const delta = { totalBytes: after.totalBytes - before.totalBytes, categories: {} };
  for (const category of Object.keys(before.categories)) {
    delta.categories[category] = after.categories[category] - before.categories[category];
  }
  for (const key of ['appliedMarkers', 'dockyardStateJsonBytes', 'officialDomainJsonBytes', 'segmentFiles', 'archiveJsonlRows']) {
    delta[key] = after[key] - before[key];
  }
  return delta;
}

function eventPayload(experimentId, type, index = 0) {
  return {
    experimentId,
    proposalId: `proposal-${experimentId}`,
    target: 'plugin:capacity-reclaim-benchmark',
    capability: 'plugin:capacity-reclaim-benchmark',
    lineageId: 'plugin:capacity-reclaim-benchmark',
    status: type === 'experiment-rejected' ? 'rejected' : type === 'canary-passed' ? 'stable' : 'promoted',
    measurement: { latencyMs: 10 + index },
    evidence: type === 'promotion-succeeded'
      ? { runtimeRecovered: true, testsPassed: true, goalPassed: true }
      : { latencyMs: 10 + index },
    failureFingerprint: type === 'experiment-rejected' ? `fp-${index}` : undefined,
    promotion: type === 'promotion-succeeded'
      ? { id: 'bench-promotion-id', rowId: 'bench-promotion-row', pluginName: 'bench-plugin', promotionTimestamp: FIXED_AT }
      : undefined,
    canary: type === 'canary-passed'
      ? { promotionTimestamp: FIXED_AT, healthObservationWindow: 2, startupVerified: true,
          observations: [{ barrierId: 'bench-barrier', healthy: true, at: FIXED_AT }] }
      : undefined,
    at: FIXED_AT,
  };
}

function memoryMegabytes(bytes) { return bytes / (1024 * 1024); }

async function runSize(records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-reclaim-'));
  temporaryHomes.add(home);
  const backend = new JsonStorageBackend(path.join(home, 'official'));
  const ctx = contextFor(home, backend);
  const config = configFor(home);
  let port = null;
  try {
    port = await openDomainStorage(ctx, config);
    const bridge = new EvolutionEventBridge({ file: config.eventBridgePath, key: KEY, writer: WRITER });
    for (let index = 0; index < records; index += 1) {
      bridge.emit('experiment-rejected', {}, eventPayload(`bench-${index}`, 'experiment-rejected', index));
    }
    const rejectedFlush = await port.flush();
    assert.equal(rejectedFlush.applied, records, `expected ${records} rejected events to be absorbed`);

    bridge.emit('measurement-completed', {}, eventPayload('bench-promotion', 'measurement-completed', records));
    bridge.emit('promotion-succeeded', {}, eventPayload('bench-promotion', 'promotion-succeeded', records + 1));
    bridge.emit('canary-passed', {}, eventPayload('bench-promotion', 'canary-passed', records + 2));
    const promotionFlush = await port.flush();
    assert.equal(promotionFlush.applied, 3, 'expected all three promotion evidence events to be absorbed');
    const events = records + 3;

    const before = snapshot(home, ctx);
    const beforeSegmentPaths = archiveSegmentFiles(home);
    const dryRunReport = await port.reclaim({ dryRun: true, archives: true, log: true, retainRecords: RETAIN_RECORDS });
    const afterDryRun = snapshot(home, ctx);
    assert.deepEqual(afterDryRun, before, 'dry run changed fixture bytes or state');

    const rssBeforeBytes = process.memoryUsage().rss;
    const maxRssBeforeKb = process.resourceUsage().maxRSS;
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const reclaimReport = await port.reclaim({
      confirmation: true,
      archives: true,
      log: true,
      retainRecords: RETAIN_RECORDS,
    });
    const durationMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const rssAfterBytes = process.memoryUsage().rss;
    const maxRssAfterKb = process.resourceUsage().maxRSS;
    const after = snapshot(home, ctx);
    const afterSegmentPaths = new Set(archiveSegmentFiles(home));
    const deletedSegments = beforeSegmentPaths.filter(file => !afterSegmentPaths.has(file));

    assert.equal(reclaimReport.dryRun, false);
    assert.ok(reclaimReport.archives, 'archive reclaim report is missing');
    assert.ok(reclaimReport.log, 'event-log reclaim report is missing');
    assert.ok(reclaimReport.transaction, 'archive transaction report is missing');
    assert.ok(after.categories.dockyard <= before.categories.dockyard,
      `dockyard grew during reclaim: ${before.categories.dockyard} -> ${after.categories.dockyard} bytes`);
    assert.equal(deletedSegments.length, reclaimReport.transaction.removedSegmentFiles,
      'reported removed segment count does not match the files deleted from dockyard');
    for (const file of deletedSegments) assert.equal(fs.existsSync(file), false, `removed segment still exists: ${file}`);

    const report = {
      records,
      events,
      dryRun: {
        report: dryRunReport,
        zeroWrite: true,
        bytesBefore: before.totalBytes,
        bytesAfter: afterDryRun.totalBytes,
      },
      before,
      reclaim: {
        durationMs,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        rssBeforeBytes: rssBeforeBytes,
        rssAfterBytes,
        maxRssBeforeKb,
        maxRssAfterKb,
        archives: {
          retired: reclaimReport.archives.retired,
          consolidated: reclaimReport.archives.consolidated,
          beforeBytes: reclaimReport.archives.beforeBytes,
          afterBytes: reclaimReport.archives.afterBytes,
        },
        log: {
          status: reclaimReport.log.status,
          discardedBytes: reclaimReport.log.discardedBytes ?? 0,
          discardedRecords: reclaimReport.log.discardedRecords ?? 0,
          prunedMarkers: reclaimReport.log.prunedMarkers ?? 0,
          evidenceEntries: reclaimReport.log.evidenceEntries ?? 0,
          retainedBytes: reclaimReport.log.retainedBytes ?? null,
        },
        transaction: {
          removedSegmentFiles: reclaimReport.transaction.removedSegmentFiles,
          removedBytes: reclaimReport.transaction.removedBytes,
        },
        deletedSegmentPaths: deletedSegments.map(file => path.relative(home, file).split(path.sep).join('/')),
      },
      after,
      delta: categoryDelta(before, after),
      recovery: null,
    };

    await port.close();
    port = null;
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    port = await openDomainStorage(ctx, config);
    const recoveredGlobal = domainGlobal(ctx);
    const retainedMarkers = Object.keys(recoveredGlobal.applied ?? {}).length;
    assert.equal(retainedMarkers, RETAIN_RECORDS, 'reopened marker count does not equal retained record count');
    assert.equal(recoveredGlobal.retention?.markers?.pruned, reclaimReport.log.prunedMarkers,
      'retention marker floor does not match the reclaim report');
    const replay = await port.flush();
    assert.deepEqual(replay, { applied: 0, duplicates: retainedMarkers },
      'reopen flush replayed discarded records or missed retained duplicates');

    const sidecar = await readEvidenceSnapshot(config.archiveDir, 'bench-promotion');
    assert.ok(sidecar, 'promotion evidence sidecar is missing');
    assert.equal(sidecar.gateEvidence?.runtimeRecovered, true, 'sidecar is missing runtimeRecovered gate evidence');
    assert.equal(sidecar.durable?.pluginName, 'bench-plugin', 'sidecar is missing durable pluginName');
    const bridgeEvidence = await readEventBridgeEvidence(config.eventBridgePath, 'bench-promotion', {
      key: KEY,
      trustedWriters: [WRITER],
    });
    assert.notEqual(bridgeEvidence?.gateEvidence?.runtimeRecovered, true,
      'truncated bridge unexpectedly still carries runtimeRecovered gate evidence');
    assert.notEqual(bridgeEvidence?.durable?.pluginName, 'bench-plugin',
      'truncated bridge unexpectedly still carries durable plugin metadata');

    const stateFile = path.join(home, 'dockyard', 'state.json');
    const indexFile = `${stateFile}.evolution-archive-index.json`;
    assert.equal(fs.existsSync(indexFile), true, 'archive index is missing after reopen');
    const integrity = inspectArchiveIntegrity({ stateFile, indexFile });
    assert.equal(integrity.valid, true, 'archive integrity check failed after reopen');
    assert.equal(integrity.missingIndexTargets.length, 0, 'archive index has missing segment targets');

    report.recovery = {
      reopened: true,
      appliedMarkers: retainedMarkers,
      retentionMarkersPruned: recoveredGlobal.retention.markers.pruned,
      flush: replay,
      sidecar: {
        exists: true,
        gateEvidenceRuntimeRecovered: sidecar.gateEvidence.runtimeRecovered,
        durablePluginName: sidecar.durable.pluginName,
      },
      bridgeEvidence: {
        returned: bridgeEvidence !== null,
        gateEvidenceRuntimeRecovered: bridgeEvidence?.gateEvidence?.runtimeRecovered ?? null,
        durablePluginName: bridgeEvidence?.durable?.pluginName ?? null,
      },
      archiveIntegrity: {
        indexExists: true,
        valid: integrity.valid,
        missingIndexTargets: integrity.missingIndexTargets.length,
      },
      dockyardBytesDidNotGrow: after.categories.dockyard <= before.categories.dockyard,
      deletedSegmentCount: deletedSegments.length,
      deletedSegmentsAbsent: deletedSegments.every(file => !fs.existsSync(file)),
    };
    return report;
  } finally {
    if (port) await port.close().catch(() => {});
    await backend.close().catch(() => {});
    try { fs.rmSync(home, { recursive: true, force: true }); } finally { temporaryHomes.delete(home); }
  }
}

function readableTable(result) {
  const mib = value => `${memoryMegabytes(value).toFixed(2)} MiB`;
  const rows = result.sizes.map(size => [
    size.records,
    `${mib(size.before.categories.dockyard)} → ${mib(size.after.categories.dockyard)}`,
    `${mib(size.before.categories.executionEvents)} → ${mib(size.after.categories.executionEvents)}`,
    `${mib(size.before.categories.official)} → ${mib(size.after.categories.official)}`,
    `${mib(size.before.categories.checkpoint)} → ${mib(size.after.categories.checkpoint)}`,
    `${mib(size.before.categories.other)} → ${mib(size.after.categories.other)}`,
    size.reclaim.transaction.removedSegmentFiles,
    `${size.reclaim.log.discardedBytes} B / ${size.reclaim.log.discardedRecords}`,
    size.reclaim.log.prunedMarkers,
    size.reclaim.durationMs.toFixed(3),
  ]);
  const headers = ['记录', 'dockyard MiB 前→后', 'event log MiB 前→后', 'official MiB 前→后', 'checkpoint MiB 前→后', 'other MiB 前→后', '删除段', '日志丢弃', '裁剪 marker', 'reclaim ms'];
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => String(row[column]).length)));
  const line = values => values.map((value, index) => String(value).padEnd(widths[index])).join('  ');
  return [
    `Node ${result.environment.node} · ${result.environment.platform}/${result.environment.arch}`,
    'single measurement per size',
    line(headers),
    line(widths.map(width => '-'.repeat(width))),
    ...rows.map(line),
    '',
    '完整计时与恢复检查请使用 --json。',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  const sizes = [];
  for (const records of args.sizes) sizes.push(await runSize(records));
  const result = {
    schema: 1,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    measurement: 'single measurement per size',
    retention: { retainRecords: RETAIN_RECORDS },
    sizes,
    notes: [
      'Each size used a separate temporary home under os.tmpdir() and the official DomainFacility + JsonStorageBackend; homes are recursively removed after each size and again on process exit.',
      'The bridge contains one measurement-completed, one promotion-succeeded, and one canary-passed event for bench-promotion. Keeping one tail record makes the promotion row part of the discarded prefix so the evidence sidecar can be checked independently of the remaining bridge.',
      'All performance values are one observation per size, not a statistical distribution.',
    ],
  };
  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${readableTable(result)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
