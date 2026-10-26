#!/usr/bin/env node
// Reproducible counterexamples for historical retention/reclaim limits.
// Every fixture lives under os.tmpdir() and is removed in the outer finally.
// Run with: node --max-old-space-size=4096 scripts/benchmarks/retention-reclaim-blockers.mjs [--measure] [--json]
import assert from 'node:assert/strict';
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { mirrorArchives, changedArchiveFiles, installArchiveFiles } from '../../lib/archive-stage.js';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { JsonStateStore } from '../../test/dockyard-domain/support.js';
import {
  eventLogCheckpointDocument,
  eventLogCheckpointPath,
  planEventLogReplay,
  readEventLogCheckpoint,
  writeEventLogCheckpoint,
} from '../../lib/event-log-checkpoint.js';
import { readEventBridgeEvidence, signEventBridgeEnvelope } from '../../lib/orchestrator.js';

const NOW = '2026-10-26T00:00:00.000Z';
const KEY = 'retention-reclaim-fixture-key-2026';
const WRITER = 'dsh-evolution-orchestrator';
const ARGUMENTS = new Set(process.argv.slice(2));
const UNKNOWN = [...ARGUMENTS].filter((arg) => !['--measure', '--json', '--help'].includes(arg));
if (UNKNOWN.length) throw new Error(`unknown arguments: ${UNKNOWN.join(', ')}`);
if (ARGUMENTS.has('--help')) {
  process.stdout.write('Usage: node --max-old-space-size=4096 scripts/benchmarks/retention-reclaim-blockers.mjs [--measure] [--json]\n');
  process.exit(0);
}

function authority() { return { assertMutation() {}, isActive: () => true }; }

function namesSummary(names) {
  return { count: names.length, first: names.slice(0, 3), last: names.slice(-3) };
}

function makeMemory(store, options = {}) {
  const memory = new EvolutionMemory({
    stateStore: store,
    clock: () => new Date(NOW),
    maxEntries: 1000,
    hotEntries: 2,
    hotCycles: 2,
    archiveMaxBytes: 512,
    absoluteMaxSegmentBytes: 4096,
    ...options,
  });
  memory.setMutationAuthority(authority());
  return memory;
}

async function segmentNames(root, collection = 'observations') {
  const directory = join(root, `state.json.${collection}-archive.jsonl.segments`);
  try {
    return (await readdir(directory)).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function jsonlArchiveStats(home) {
  const root = join(home, '.dockyard-dsh');
  let totalBytes = 0;
  let totalLines = 0;
  let archiveFiles = 0;
  const collections = {};
  async function addFile(file, collection, segment) {
    const bytes = await readFile(file);
    const lines = bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').length;
    totalBytes += bytes.length;
    totalLines += lines;
    archiveFiles += 1;
    const current = collections[collection] ?? { bytes: 0, lines: 0, files: 0, segments: 0 };
    current.bytes += bytes.length;
    current.lines += lines;
    current.files += 1;
    if (segment) current.segments += 1;
    collections[collection] = current;
  }
  let names = [];
  try { names = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of names) {
    const activeMatch = /^state\.json\.([A-Za-z]+)-archive\.jsonl$/.exec(entry.name);
    const segmentsMatch = /^state\.json\.([A-Za-z]+)-archive\.jsonl\.segments$/.exec(entry.name);
    if (activeMatch && entry.isFile()) {
      await addFile(join(root, entry.name), activeMatch[1], false);
    } else if (segmentsMatch && entry.isDirectory()) {
      const archive = join(root, entry.name);
      for (const segment of (await readdir(archive)).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort()) {
        await addFile(join(archive, segment), segmentsMatch[1], true);
      }
    }
  }
  return { totalBytes, totalLines, archiveFiles, segments: Object.values(collections).reduce((sum, value) => sum + value.segments, 0), collections };
}

async function runR1(root) {
  const home = join(root, 'r1-live');
  const archiveRoot = join(home, '.dockyard-dsh');
  await mkdir(archiveRoot, { recursive: true });
  const liveStore = new JsonStateStore({ home });
  const sourceRows = Array.from({ length: 320 }, (_, index) => ({
    id: `observation-${String(index + 1).padStart(4, '0')}`,
    type: 'component/observation',
    severity: 'info',
    componentId: `component-${index % 4}`,
    recordedAt: NOW,
    metrics: { usageCount: index + 1 },
    payload: 'synthetic-row-' + String(index % 4) + '-' + 'x'.repeat(120),
  }));
  await writeFile(liveStore.filePath, JSON.stringify({ evolution: { observations: sourceRows } }), { mode: 0o600 });

  const live = makeMemory(liveStore);
  await live.load();
  const initialLiveNames = await segmentNames(archiveRoot);
  const liveSourceHistory = live.history('observations');
  const sourceIds = new Set(sourceRows.map((row) => row.id));

  const stageRoot = join(root, 'r1-stage');
  const snapshot = mirrorArchives(archiveRoot, stageRoot);
  const stageStatePath = join(stageRoot, 'state.json');
  await copyFile(liveStore.filePath, stageStatePath);
  const stageStore = new JsonStateStore({ filePath: stageStatePath });
  const staged = makeMemory(stageStore);
  await staged.load();
  const stageBefore = await segmentNames(stageRoot);
  const compactReport = await staged.compact();
  const stageAfter = await segmentNames(stageRoot);
  const changed = changedArchiveFiles(stageRoot, snapshot);
  const stageOnlySegments = stageBefore.filter((name) => !stageAfter.includes(name));

  // In the real pending protocol the new aggregate is committed before its
  // staged archive list is installed. Reproduce that aggregate publication with
  // the same test JsonStateStore, then use the production archive installer.
  const stagedState = await stageStore.load();
  await liveStore.update(() => stagedState);
  installArchiveFiles(stageRoot, archiveRoot, changed);

  const liveNamesAfterInstall = await segmentNames(archiveRoot);
  const indexPath = join(archiveRoot, 'state.json.evolution-archive-index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const indexedObservationSegments = new Set(index.segments
    .filter((entry) => entry.collection === 'observations' && /^segment-[0-9]+\.jsonl$/.test(entry.file))
    .map((entry) => entry.file));
  const unindexedLiveSegmentsBeforeRestart = liveNamesAfterInstall.filter((name) => !indexedObservationSegments.has(name));

  const reopened = makeMemory(new JsonStateStore({ home }));
  await reopened.load();
  const history = reopened.history('observations');
  const historyIds = history.map((entry) => String(entry?.id ?? '')).filter(Boolean);
  const counts = new Map();
  for (const id of historyIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const resurrectedSourceIds = historyIds.filter((id) => sourceIds.has(id));
  const aggregateRows = history.filter((entry) => entry?.retention === 'AGGREGATED');
  const consistency = await reopened.verifyConsistency();

  return {
    purpose: 'mirror live archives, compact in a staged EvolutionMemory, publish the aggregate, and install only changedArchiveFiles()',
    input: { sourceObservationRows: sourceRows.length, liveHistoryRowsBefore: liveSourceHistory.length, initialSealedSegments: initialLiveNames.length },
    compaction: {
      beforeSealedSegments: stageBefore.length,
      afterSealedSegments: stageAfter.length,
      segmentCountReduced: stageAfter.length < stageBefore.length,
      stageRemovedSegmentNames: namesSummary(stageOnlySegments),
      retired: compactReport.retired,
      consolidated: compactReport.consolidated,
      aggregatedObservations: compactReport.aggregatedObservations,
      beforeRows: compactReport.before.observations,
      afterRows: compactReport.after.observations,
    },
    changedArchiveFiles: {
      count: changed.length,
      entries: changed.map(({ file, bytes }) => ({ file, bytes })),
      containsDeletionEntries: false,
      stageDeletedSegmentNamesRepresented: namesSummary(stageOnlySegments.filter((name) => changed.some((entry) => entry.file.endsWith(`/${name}`)))),
    },
    afterInstallBeforeRestart: {
      liveSegmentNames: namesSummary(liveNamesAfterInstall),
      unindexedLiveSegmentNames: namesSummary(unindexedLiveSegmentsBeforeRestart),
      staleStageDeletedNamesStillLive: namesSummary(stageOnlySegments.filter((name) => liveNamesAfterInstall.includes(name))),
    },
    afterRestart: {
      historyRows: history.length,
      originalSourceIdsReadable: resurrectedSourceIds.length,
      aggregateRowsReadable: aggregateRows.length,
      originalAndAggregateBothReadable: resurrectedSourceIds.length > 0 && aggregateRows.length > 0,
      duplicateIds: duplicateIds.length,
      duplicateIdExamples: duplicateIds.slice(0, 10),
      verifyConsistency: { valid: consistency.valid, reasons: consistency.reasons, archiveValid: consistency.archive?.valid ?? null },
    },
    result: stageAfter.length < stageBefore.length
      ? (resurrectedSourceIds.length > 0 && aggregateRows.length > 0
        ? '成立：已安装清单没有表达段删除，旧源记录与聚合记录在重启后同时可读。'
        : '部分成立：compact 减少了段，但重启后未观察到旧源记录与聚合记录同时可读。')
      : '不成立：本夹具的 compact 未减少段数，未形成删除路径反例。',
  };
}

async function runR2(root) {
  const directory = join(root, 'r2-checkpoint');
  await mkdir(directory, { recursive: true });
  const logFile = join(directory, 'execution-events.jsonl');
  const checkpointFile = eventLogCheckpointPath(directory);
  const count = 200;
  const applied = {};
  const envelopes = [];
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const event = {
      schema: 1,
      eventId: `fixture:event:${sequence}`,
      eventType: 'measurement-completed',
      experimentId: `fixture-experiment-${sequence}`,
      status: 'measured',
      measurement: { sequence, value: sequence },
      audit: { at: NOW },
    };
    const envelope = signEventBridgeEnvelope(event, { key: KEY, writer: WRITER, sequence });
    envelopes.push(envelope);
    applied[event.eventId] = envelope.mac;
  }
  await writeFile(logFile, envelopes.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n', { mode: 0o600 });
  const coldPlan = planEventLogReplay({ file: logFile, key: KEY, writer: WRITER, checkpoint: null, applied });
  const document = eventLogCheckpointDocument({
    plan: coldPlan,
    writer: WRITER,
    key: KEY,
    applied,
    witnesses: {
      first: { id: envelopes[0].event.eventId, mac: envelopes[0].mac },
      last: { id: envelopes.at(-1).event.eventId, mac: envelopes.at(-1).mac },
    },
  });
  writeEventLogCheckpoint(checkpointFile, document);
  const checkpoint = readEventLogCheckpoint(checkpointFile);
  const trustedPlan = planEventLogReplay({ file: logFile, key: KEY, writer: WRITER, checkpoint, applied });
  const trimmedApplied = { ...applied };
  delete trimmedApplied[envelopes[Math.floor(count / 2)].event.eventId];
  const trimmedPlan = planEventLogReplay({ file: logFile, key: KEY, writer: WRITER, checkpoint, applied: trimmedApplied });

  return {
    records: count,
    appliedMarkersBefore: Object.keys(applied).length,
    appliedMarkersAfterRemovingOne: Object.keys(trimmedApplied).length,
    checkpoint: { written: checkpoint !== null, bytes: checkpoint?.bytes ?? null, records: checkpoint?.records ?? null },
    trusted: {
      trusted: trustedPlan.trusted,
      prefixRecords: trustedPlan.prefixRecords,
      recordsToProcess: trustedPlan.completeRecords,
      linesReturned: trustedPlan.lines.length,
    },
    oneMarkerRemoved: {
      trusted: trimmedPlan.trusted,
      prefixRecords: trimmedPlan.prefixRecords,
      recordsToProcess: trimmedPlan.completeRecords,
      linesReturned: trimmedPlan.lines.length,
      skippedRecords: trimmedPlan.prefixRecords,
    },
    cost: {
      trustedRecordsPerRecordWork: trustedPlan.completeRecords,
      untrustedRecordsPerRecordWork: trimmedPlan.completeRecords,
      extraRecordsPerRecordWork: trimmedPlan.completeRecords - trustedPlan.completeRecords,
      trustedCanSkipConsumedPrefix: trustedPlan.prefixRecords,
      afterMarkerRemovalCanSkipConsumedPrefix: trimmedPlan.prefixRecords,
    },
    result: trimmedPlan.trusted
      ? '不成立：裁剪一个 applied marker 后 checkpoint 仍可信。'
      : `成立：裁剪一个 marker 后 appliedDigest 不再匹配，${trimmedPlan.prefixRecords} 条可跳过前缀退回到逐条处理 ${trimmedPlan.completeRecords} 条。`,
  };
}

function ownPathChanges(before, after, path = '$') {
  if (Object.is(before, after)) return [];
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') return [{ path, before: before ?? null, after: after ?? null }];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = [];
  for (const key of keys) {
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
      changes.push({ path: `${path}.${key}`, before: Object.hasOwn(before, key) ? before[key] : '(missing)', after: Object.hasOwn(after, key) ? after[key] : '(missing)' });
    } else changes.push(...ownPathChanges(before[key], after[key], `${path}.${key}`));
  }
  return changes;
}

async function runR3(root) {
  const file = join(root, 'r3-events.jsonl');
  const experimentId = 'fixture-promotion-evidence';
  const events = [
    {
      schema: 1, eventId: 'fixture:measurement:1', eventType: 'measurement-completed', experimentId,
      status: 'measured', measurement: { latencyMs: 14, observed: 1 }, audit: { at: '2026-10-26T00:00:01.000Z' },
    },
    {
      schema: 1, eventId: 'fixture:promotion:1', eventType: 'promotion-succeeded', experimentId,
      evidence: { runtimeRecovered: true, testsPassed: true, goalPassed: true },
      measurement: { latencyMs: 12, observed: 2 },
      promotion: {
        pluginName: 'fixture-plugin', pluginPath: '/tmp/fixture-plugin', linkPath: '/tmp/fixture-link',
        rowId: 'row-fixture-1', archivePath: '/tmp/fixture-archive', presetId: 'preset-fixture',
        promotionTimestamp: '2026-10-26T00:00:02.000Z', healthObservationWindow: 2,
      },
      audit: { at: '2026-10-26T00:00:02.000Z' },
    },
    {
      schema: 1, eventId: 'fixture:canary:1', eventType: 'canary-passed', experimentId,
      canary: { startupVerified: true, observations: [{ healthy: true, at: '2026-10-26T00:00:03.000Z' }] },
      audit: { at: '2026-10-26T00:00:03.000Z' },
    },
  ];
  const envelopes = events.map((event, index) => signEventBridgeEnvelope(event, { key: KEY, writer: WRITER, sequence: index + 1 }));
  await writeFile(file, envelopes.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n', { mode: 0o600 });
  const before = await readEventBridgeEvidence(file, experimentId, { key: KEY, trustedWriters: [WRITER] });
  const removedEventType = 'promotion-succeeded';
  const kept = envelopes.filter((envelope) => envelope.event.eventType !== removedEventType);
  await writeFile(file, kept.map((envelope) => JSON.stringify(envelope)).join('\n') + '\n', { mode: 0o600 });
  const after = await readEventBridgeEvidence(file, experimentId, { key: KEY, trustedWriters: [WRITER] });
  const changes = ownPathChanges(before, after);

  return {
    logRowsBefore: envelopes.length,
    removedLine: { eventType: removedEventType, removed: true },
    before: {
      capturedAt: before?.capturedAt ?? null,
      promotionTimestamp: before?.promotionTimestamp ?? null,
      latestObservation: before?.latestObservation ?? null,
      gateEvidence: before?.gateEvidence ?? null,
      recoveryProof: before?.recoveryProof ?? null,
      runtimeRecovered: before?.runtimeRecovered ?? null,
      durable: before?.durable ?? null,
      canary: before?.canary ?? null,
      cleanupProof: before?.cleanupProof ?? null,
      observationCount: before?.observations?.length ?? null,
    },
    after: {
      capturedAt: after?.capturedAt ?? null,
      promotionTimestamp: after?.promotionTimestamp ?? null,
      latestObservation: after?.latestObservation ?? null,
      gateEvidence: after?.gateEvidence ?? null,
      recoveryProof: after?.recoveryProof ?? null,
      runtimeRecovered: after?.runtimeRecovered ?? null,
      durable: after?.durable ?? null,
      canary: after?.canary ?? null,
      cleanupProof: after?.cleanupProof ?? null,
      observationCount: after?.observations?.length ?? null,
    },
    changedEvidenceFields: changes,
    bridgeNeverCarries: { cleanupProof: 'always null; it is not represented by these event rows' },
    result: changes.length > 0 && after?.gateEvidence === null && after?.durable === null
      ? '成立：删除 promotion-succeeded 行后晋升门禁与 durable 元数据消失；measurement 与 canary 行仍可提供其各自字段。'
      : '不成立：截掉所选事实行后，目标 evidence 字段仍由剩余行提供。',
  };
}

async function writeCorpus(root, count) {
  const home = join(root, 'r4-source');
  await mkdir(home, { recursive: true });
  const store = new JsonStateStore({ home });
  const memory = makeMemory(store, { hotEntries: 32, hotCycles: 32, archiveMaxBytes: 512 * 1024, absoluteMaxSegmentBytes: 2 * 1024 * 1024 });
  await memory.load();
  const setupStart = performance.now();
  const payload = 'synthetic terminal experiment payload '.repeat(8);
  for (let index = 1; index <= count; index += 1) {
    await memory.recordExperiment({
      id: `experiment-${String(index).padStart(5, '0')}`,
      status: 'failed',
      lifecycleState: 'FAILED',
      recordedAt: NOW,
      hypothesis: `${payload}${index}`,
      audit: { source: 'retention-reclaim-benchmark', ordinal: index },
    });
  }
  const setupMs = performance.now() - setupStart;
  return { home, setupMs, recordCount: count, memory };
}

async function measureOne(root, sourceHome, round, lane, orderPosition) {
  const home = join(root, `r4-round-${round}-${lane}`);
  await cp(sourceHome, home, { recursive: true, force: false, errorOnExist: true });
  const store = new JsonStateStore({ home });
  const memory = makeMemory(store, { hotEntries: 32, hotCycles: 32, archiveMaxBytes: 512 * 1024, absoluteMaxSegmentBytes: 2 * 1024 * 1024 });
  await memory.load();
  const before = await jsonlArchiveStats(home);
  const start = performance.now();
  const report = await memory.compact();
  const compactMs = performance.now() - start;
  const after = await jsonlArchiveStats(home);
  return {
    round,
    lane,
    orderPosition,
    before,
    after,
    deltaBytes: after.totalBytes - before.totalBytes,
    reclaimedBytes: before.totalBytes - after.totalBytes,
    retired: report.retired,
    consolidated: report.consolidated,
    aggregatedObservations: report.aggregatedObservations,
    compactMs,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runR4(root) {
  const recordCount = 20000;
  const corpus = await writeCorpus(root, recordCount);
  const sourceBefore = await jsonlArchiveStats(corpus.home);
  // Verify the input corpus went through EvolutionMemory's public write path
  // and actually contains the requested count in its experiment cold layer.
  const sourceHistoryRows = corpus.memory.history('experiments').length;
  assert.equal(sourceHistoryRows, recordCount, 'the real experiment write path must preserve the requested history count before compact');
  const coldExperimentLines = sourceBefore.collections.experiments?.lines ?? 0;
  assert.equal(coldExperimentLines, recordCount - 32, 'the cold experiment archive must contain every record evicted from the 32-row hot window');
  const orders = [['A', 'B'], ['B', 'A'], ['A', 'B']];
  const samples = [];
  for (let roundIndex = 0; roundIndex < orders.length; roundIndex += 1) {
    const round = roundIndex + 1;
    for (const [orderIndex, lane] of orders[roundIndex].entries()) {
      samples.push(await measureOne(root, corpus.home, round, lane, orderIndex + 1));
    }
  }
  const fields = [
    'before.totalBytes', 'before.segments', 'before.totalLines',
    'after.totalBytes', 'after.segments', 'after.totalLines',
    'deltaBytes', 'reclaimedBytes', 'retired', 'consolidated', 'compactMs',
  ];
  const valueAt = (sample, key) => key.split('.').reduce((value, segment) => value[segment], sample);
  const medians = Object.fromEntries(fields.map((field) => [field, median(samples.map((sample) => valueAt(sample, field)))]));
  return {
    corpus: {
      requestedExperiments: recordCount,
      historyRowsBeforeCompact: sourceHistoryRows,
      coldExperimentLines,
      realWriteApi: 'EvolutionMemory#recordExperiment()',
      setupMs: corpus.setupMs,
      coldArchiveBefore: sourceBefore,
      filesClonedFromRealWriteOutput: true,
      statement: 'Each timing run starts from a byte-for-byte copy of this real-write output; JSONL fixture rows were not hand-authored.',
    },
    measurement: {
      definition: 'A and B are independent fresh copies of the same fixture, both calling real EvolutionMemory#compact(); lane order alternates AB / BA / AB.',
      rounds: orders.map((order, index) => ({ round: index + 1, order })),
      samples,
      medians,
      interpretation: 'Measured compact delta is the observed net archive size change. It is only an upper-bound scenario for reclaim that could be safely delivered; it is not delivered reclaim behavior.',
    },
    result: `成立：20,000 条真实写入的失败实验经 compact 后，冷档案净减少的中位数为 ${medians.reclaimedBytes} bytes（如为负数则为净增长）；这只是测得的可回收上限场景。`,
  };
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-retention-reclaim-blockers-'));
  try {
    const result = {
      schema: 1,
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      measurementRequested: ARGUMENTS.has('--measure'),
      fixtures: 'all under os.tmpdir(); removed before process exit',
      r1: await runR1(tempRoot),
      r2: await runR2(tempRoot),
      r3: await runR3(tempRoot),
    };
    if (ARGUMENTS.has('--measure')) result.r4 = await runR4(tempRoot);
    if (ARGUMENTS.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const [id, section] of Object.entries(result).filter(([key]) => /^r[1-4]$/.test(key))) {
        process.stdout.write(`${id.toUpperCase()}: ${section.result}\n`);
      }
      if (!result.r4) process.stdout.write('追加 R4: 使用 --measure 运行。\n');
      process.stdout.write(`环境: ${result.environment.node} ${result.environment.platform}/${result.environment.arch}\n`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
