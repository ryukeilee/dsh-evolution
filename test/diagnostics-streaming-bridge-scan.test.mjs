import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectDiagnostics, inspectJsonLines, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { openDomainStorage, evolutionDomainSpec } from '../lib/domain-storage.js';
import {
  EVENT_BRIDGE_DEFAULT_WRITER,
  EvolutionEventBridge,
  eventBridgeWriterTrusted,
  signEventBridgeEnvelope,
  verifyEventBridgeEnvelope,
} from '../lib/orchestrator.js';

const KEY = 'a'.repeat(64);
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

function freshHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `streaming-bridge-${name}-`));
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  fs.writeFileSync(paths.keyPath, KEY, { mode: 0o600 });
  return { home, paths };
}

function signed(event, sequence, writer = EVENT_BRIDGE_DEFAULT_WRITER) {
  return signEventBridgeEnvelope(event, { key: KEY, sequence, writer });
}

function event(eventId, { at = '2026-08-26T12:00:00.000Z', payload = '' } = {}) {
  return { schema: 1, eventId, eventType: 'trial-completed', audit: { at }, payload };
}

function frozenPreChangeCheck(paths) {
  // Frozen from diagnoseEventBridge before the streaming change: whole-file
  // UTF-8 read, inspectJsonLines record materialization, then its original loop.
  const stat = (() => { try { return fs.lstatSync(paths.eventBridgePath); } catch { return null; } })();
  if (!stat) return {
    id: 'state.event-bridge', level: 'ok',
    summary: 'No execution event bridge yet (fresh install).',
    evidence: { eventBridgePath: paths.eventBridgePath, present: false },
  };
  const text = fs.readFileSync(paths.eventBridgePath, 'utf8');
  const inspected = inspectJsonLines(text);
  const unverifiable = [];
  const malformed = [];
  const untrustedWriters = [];
  const writersSeen = [];
  const writer = EVENT_BRIDGE_DEFAULT_WRITER;
  const writerSource = 'bundle-default';
  const writerKnown = true;
  const byEventId = new Map();
  const conflicts = [];
  let duplicates = 0;
  for (const record of inspected.records) {
    if (record.empty) continue;
    if (record.error) { malformed.push({ line: record.line, error: record.error }); continue; }
    const verified = verifyEventBridgeEnvelope(record.value, KEY);
    if (!verified) { unverifiable.push({ line: record.line, sequence: record.value?.sequence ?? null, writer: record.value?.writer ?? null }); continue; }
    if (writerKnown) {
      if (!eventBridgeWriterTrusted(verified, writer)) { untrustedWriters.push({ line: record.line, sequence: verified.sequence, writer: verified.writer }); continue; }
    } else if (typeof verified.writer === 'string' && !writersSeen.includes(verified.writer)) {
      writersSeen.push(verified.writer);
    }
    const eventId = typeof verified.event?.eventId === 'string' ? verified.event.eventId : null;
    if (!eventId) continue;
    const mac = record.value.mac;
    const previous = byEventId.get(eventId);
    if (previous && previous !== mac) conflicts.push({ eventId, lines: previous, mac });
    else if (previous) duplicates += 1;
    else byEventId.set(eventId, mac);
  }
  const problems = [];
  if (malformed.length > 0) problems.push(`${malformed.length} malformed line(s)`);
  if (unverifiable.length > 0) problems.push(`${unverifiable.length} envelope(s) fail MAC verification`);
  if (untrustedWriters.length > 0) problems.push(`${untrustedWriters.length} envelope(s) name a writer other than ${writer} (signed by: ${[...new Set(untrustedWriters.map((entry) => entry.writer))].slice(0, 4).join(', ')})`);
  if (conflicts.length > 0) problems.push(`${conflicts.length} event id(s) recorded with conflicting MACs`);
  const truncated = inspected.truncatedTail && malformed.some((entry) => entry.line === inspected.lineCount);
  const hasCompletePrefix = text.includes('\n');
  const evidence = {
    eventBridgePath: paths.eventBridgePath, bytes: stat.size, lines: inspected.lineCount,
    verifiedEvents: byEventId.size, duplicateRecords: duplicates,
    unverifiable, malformed: malformed.slice(0, 8), conflicts: conflicts.slice(0, 8),
    untrustedWriters: untrustedWriters.slice(0, 8),
    truncatedTail: truncated,
    trustedWriter: writer, writerSource,
  };
  if (problems.length > 0) {
    const repair = truncated && malformed.length === 1 && unverifiable.length === 0 && conflicts.length === 0 && untrustedWriters.length === 0 && hasCompletePrefix
      ? {
        id: 'event-bridge-trim-partial-tail',
        safe: true,
        description: `Drop the unterminated final line ${inspected.lineCount} (${malformed[0].error}); no complete record is removed.`,
      }
      : undefined;
    const onlyPartialTail = truncated && malformed.length === 1 && unverifiable.length === 0 && conflicts.length === 0 && untrustedWriters.length === 0;
    return {
      id: 'state.event-bridge', level: 'blocked',
      summary: `The event bridge cannot be replayed as-is: ${problems.join('; ')}.`, evidence,
      remediation: conflicts.length > 0
        ? 'Conflicting MACs mean the same event id was recorded with different content; freeze the file and resolve by hand (the plugin refuses to guess).'
        : untrustedWriters.length > 0
          ? `Records signed by another writer cannot be replayed: this installation only trusts \`${writer}\` (${writerSource}). Restore the log this installation wrote, or freeze the file and resolve by hand. If this installation configures a different eventBridgeWriter that the doctor could not read (--no-composition, or the profile does not state it), run the diagnostic with --profile so the composed profile is read.`
          : onlyPartialTail && !hasCompletePrefix
            ? 'The file is a single unterminated record with no verified complete prefix to keep, so no automatic repair is offered; freeze the file and resolve it by hand.'
            : 'Restore the original key or the original file; the plugin refuses to start on unverifiable events.',
      recoverable: Boolean(repair),
      ...(repair ? { repair } : {}),
    };
  }
  return {
    id: 'state.event-bridge', level: 'ok',
    summary: `Event bridge verifies: ${byEventId.size} signed event(s), ${duplicates} idempotent duplicate(s), verified against the trusted writer \`${writer}\` (${writerSource}).`,
    evidence,
  };
}

async function assertMatchesOracle(home, paths, { readChunkCap = null } = {}) {
  const expected = frozenPreChangeCheck(paths);
  const originalReadSync = fs.readSync;
  let readCalls = 0;
  fs.readSync = function (fd, buffer, offset, length, position) {
    readCalls += 1;
    return originalReadSync.call(this, fd, buffer, offset, readChunkCap === null ? length : Math.min(length, readChunkCap), position);
  };
  let report;
  try {
    report = await collectDiagnostics({ dshHome: home, paths, home: true, probe: { skipComposition: true } });
  } finally {
    fs.readSync = originalReadSync;
  }
  const actual = report.checks.find((check) => check.id === 'state.event-bridge');
  assert.ok(actual, 'state.event-bridge is present');
  assert.equal(actual.id, expected.id);
  assert.equal(actual.level, expected.level);
  assert.equal(actual.summary, expected.summary);
  assert.deepEqual(actual.evidence, expected.evidence);
  for (const field of ['remediation', 'recoverable', 'repair']) {
    assert.equal(Object.hasOwn(actual, field), Object.hasOwn(expected, field), `${field} presence`);
    if (Object.hasOwn(expected, field)) assert.deepEqual(actual[field], expected[field], `${field} content`);
  }
  return { report, actual, readCalls };
}

test('streamed event bridge scan matches the frozen whole-file implementation', async () => {
  const scenarios = [
    ['empty file', () => ''],
    ['only blank lines', () => '  \t\n\r\n\n'],
    ['no trailing LF', () => JSON.stringify(signed(event('single'), 1))],
    ['CRLF', () => `${JSON.stringify(signed(event('crlf-a'), 1))}\r\n${JSON.stringify(signed(event('crlf-b'), 2))}\r\n`],
    ['torn final line', () => `${JSON.stringify(signed(event('prefix'), 1))}\n{"schema":2,"writer":"partial`],
    ['bad MAC envelope', () => {
      const envelope = signed(event('tampered'), 1);
      envelope.mac = 'b'.repeat(64);
      return `${JSON.stringify(envelope)}\n`;
    }],
    ['untrusted-writer envelope', () => `${JSON.stringify(signed(event('foreign'), 1, 'other-writer'))}\n`],
    ['duplicate ids', () => {
      const line = JSON.stringify(signed(event('duplicate'), 1));
      return `${line}\n${line}\n`;
    }],
    ['conflicting ids with different MACs', () => `${JSON.stringify(signed(event('conflict', { payload: 'first' }), 1))}\n${JSON.stringify(signed(event('conflict', { payload: 'second' }), 2))}\n`],
  ];
  for (const [name, makeText] of scenarios) {
    const { home, paths } = freshHome(name.replaceAll(' ', '-'));
    try {
      fs.writeFileSync(paths.eventBridgePath, makeText());
      await assertMatchesOracle(home, paths);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  {
    const { home, paths } = freshHome('utf8-boundary');
    try {
      let serialized;
      for (let fillerLength = 0; fillerLength < 256; fillerLength += 1) {
        serialized = JSON.stringify(signed(event('utf8-boundary', { payload: `${'x'.repeat(fillerLength)}💠` }), 1));
        const markerOffset = Buffer.from(serialized).indexOf(Buffer.from('💠'));
        if (markerOffset % 37 === 36) break;
      }
      const markerOffset = Buffer.from(serialized).indexOf(Buffer.from('💠'));
      assert.equal(markerOffset % 37, 36, 'the four-byte UTF-8 character straddles two 37-byte reads');
      fs.writeFileSync(paths.eventBridgePath, `${serialized}\n`);
      const { readCalls } = await assertMatchesOracle(home, paths, { readChunkCap: 37 });
      assert.ok(readCalls > 2, 'the file was read across multiple capped chunks');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  {
    const { home, paths } = freshHome('twenty-thousand-lines');
    try {
      const lines = [];
      for (let index = 0; index < 20_000; index += 1) {
        lines.push(JSON.stringify(signed(event(`generated-${index}`, {
          at: `2026-08-26T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
          payload: 'p'.repeat(400),
        }), index + 1)));
      }
      fs.writeFileSync(paths.eventBridgePath, `${lines.join('\n')}\n`);
      assert.ok(fs.statSync(paths.eventBridgePath).size > 5 * 1024 * 1024, '20,000 lines span multiple 1 MiB scan chunks');
      const { readCalls, actual } = await assertMatchesOracle(home, paths);
      assert.ok(readCalls > 5, 'the generated log required multiple forward read chunks');
      assert.equal(actual.evidence.lines, 20_000);
      assert.equal(actual.evidence.verifiedEvents, 20_000);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }

  {
    const { home, paths } = freshHome('enoent');
    try { await assertMatchesOracle(home, paths); }
    finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('event bridge capacity evidence uses verified durable markers only', async () => {
  const { home, paths } = freshHome('capacity');
  const backend = new JsonStorageBackend(path.join(home, 'official-domain'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: paths.dataRoot, eventBridgePath: paths.eventBridgePath, eventBridgeKey: KEY };
  const bridge = new EvolutionEventBridge({ file: paths.eventBridgePath, key: KEY });
  let port;
  try {
    port = await openDomainStorage(ctx, config);
    const dates = Array.from({ length: 5 }, (_, index) => `2026-08-26T12:00:0${index}.000Z`);
    for (const [index, at] of dates.entries()) {
      bridge.emit('trial-completed', { id: `exp-capacity-${index}`, proposal: { target: `plugin:capacity-${index}` }, state: 'stable' }, { at });
    }
    assert.equal((await port.replay()).applied, dates.length);
    const global = ctx.storageDomain.get(evolutionDomainSpec.name).global.get();
    assert.equal(Object.keys(global.applied).length, dates.length);
    fs.mkdirSync(path.dirname(paths.domainGlobalPath), { recursive: true });
    fs.writeFileSync(paths.domainGlobalPath, JSON.stringify({
      unit: { name: evolutionDomainSpec.name, version: 1 }, global, tables: {},
    }));
    await port.close();
    port = null;
    await backend.close();

    const report = await collectDiagnostics({ dshHome: home, paths, home: true, probe: { skipComposition: true } });
    const check = report.checks.find((entry) => entry.id === 'state.event-bridge');
    assert.equal(check.evidence.verifiedEvents, dates.length);
    assert.equal(check.evidence.absorbedRecords, dates.length);
    assert.equal(check.evidence.unabsorbedRecords, 0);
    assert.equal(check.evidence.oldestRecordAt, dates[0]);
    assert.equal(check.evidence.newestRecordAt, dates.at(-1));
    assert.equal(report.checks.find((entry) => entry.id === 'state.domain').evidence.aggregateVerified, true);
  } finally {
    if (port) await port.close();
    await backend.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  const { home: unavailableHome, paths: unavailablePaths } = freshHome('capacity-domain-unavailable');
  try {
    fs.writeFileSync(unavailablePaths.eventBridgePath, `${JSON.stringify(signed(event('unabsorbed'), 1))}\n`);
    const report = await collectDiagnostics({ dshHome: unavailableHome, paths: unavailablePaths, home: true, probe: { skipComposition: true } });
    const evidence = report.checks.find((entry) => entry.id === 'state.event-bridge').evidence;
    for (const field of ['absorbedRecords', 'unabsorbedRecords', 'oldestRecordAt', 'newestRecordAt']) {
      assert.equal(Object.hasOwn(evidence, field), false, `${field} is absent without verified domain marker evidence`);
    }
  } finally { fs.rmSync(unavailableHome, { recursive: true, force: true }); }
});
