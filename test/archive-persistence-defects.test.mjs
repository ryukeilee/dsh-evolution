import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { EvolutionMemory } from '../lib/dockyard-domain/memory.js';
import { runDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import { evolutionDomainSpec, openDomainStorage } from '../lib/domain-storage.js';

const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const authority = { assertMutation() {}, isActive: () => true };
const segmentName = (number) => `segment-${String(number).padStart(12, '0')}.jsonl`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function officialHome(t, { archiveMaxBytes = 256 } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-archive-persistence-'));
  const dataRoot = path.join(home, 'storages', 'evolution');
  const backend = new JsonStorageBackend(path.join(home, 'official-json-backend'));
  const ctx = {
    emit() {},
    effect() {},
    logger: { warn() {}, error() {}, info() {} },
    storage: { backend: { get(name) { if (name !== 'json') throw new Error(`unexpected backend ${name}`); return backend; } } },
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  let domain;
  try {
    domain = await ctx.storageDomain.open(evolutionDomainSpec);
  } catch (error) {
    await backend.close();
    await fs.rm(home, { recursive: true, force: true });
    throw error;
  }
  const stateStore = {
    filePath: path.join(dataRoot, 'dockyard', 'state.json'),
    async load() { return domain.global.get().aggregate; },
    async update(updater) {
      const current = domain.global.get();
      await domain.global.set({ ...current, aggregate: updater(current.aggregate) });
    },
  };
  const openMemory = async (options = {}) => {
    const memory = new EvolutionMemory({ stateStore, hotEntries: 1, archiveMaxBytes, absoluteMaxSegmentBytes: 4096, ...options });
    memory.setMutationAuthority(authority);
    await memory.load();
    return memory;
  };
  t.after(async () => {
    await domain?.close();
    await backend.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, dataRoot, backend, domain, stateStore, openMemory };
}

async function appendObservations(memory, count, prefix = 'cold') {
  for (let index = 0; index < count; index += 1) {
    await memory.recordObservation({
      id: `${prefix}-${index}`,
      type: 'component/observation',
      payload: 'x'.repeat(100),
      recordedAt: `2026-10-26T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
  }
}

function observationArchive(stateFile) { return `${stateFile}.observations-archive.jsonl`; }
function segmentDirectory(stateFile) { return `${observationArchive(stateFile)}.segments`; }
function archiveIndex(stateFile) { return `${stateFile}.evolution-archive-index.json`; }

async function archiveTreeBytes(stateFile) {
  const root = path.dirname(stateFile);
  const base = path.basename(stateFile);
  const files = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === `${base}.evolution-archive-index.json`
      || (entry.isFile() && entry.name.startsWith(`${base}.`) && entry.name.endsWith('-archive.jsonl'))) {
      files[entry.name] = await fs.readFile(path.join(root, entry.name));
      continue;
    }
    if (!entry.isDirectory() || !entry.name.startsWith(`${base}.`) || !entry.name.endsWith('-archive.jsonl.segments')) continue;
    const directory = path.join(root, entry.name);
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name);
      if ((await fs.stat(target)).isFile()) files[`${entry.name}/${name}`] = await fs.readFile(target);
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

async function appendValidLineToSealedObservation(segmentPath) {
  const originalBytes = await fs.readFile(segmentPath);
  const changedBytes = Buffer.concat([originalBytes, Buffer.from(`${JSON.stringify({
    id: 'tampered-valid-line', type: 'component/observation', recordedAt: '2026-10-26T01:00:00.000Z', payload: 'new legal line',
  })}\n`)]);
  await fs.writeFile(segmentPath, changedBytes);
  return { originalBytes, changedBytes };
}

test('missing segment evidence survives restart, append, and filename reuse until original bytes return', async (t) => {
  const { home, stateStore, openMemory } = await officialHome(t);
  const fixedClock = () => new Date('2026-10-26T00:00:00.000Z');
  const memory = await openMemory({ clock: fixedClock });
  await appendObservations(memory, 12);
  const directory = segmentDirectory(stateStore.filePath);
  const names = (await fs.readdir(directory)).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  assert.ok(names.length > 1, 'the official archive writer rotated the observations');
  const missingName = names.at(-1);
  const missingPath = path.join(directory, missingName);
  const originalBytes = await fs.readFile(missingPath);
  const beforeEntry = JSON.parse(await fs.readFile(archiveIndex(stateStore.filePath), 'utf8')).segments
    .find((entry) => entry.collection === 'observations' && entry.file === missingName);
  assert.ok(beforeEntry?.sha256);
  await fs.rm(missingPath);

  let restarted = await openMemory({ clock: fixedClock });
  let fault = restarted.archiveIntegrity().observations?.find((entry) => entry.kind === 'missing-segment');
  assert.ok(fault, 'the absent indexed segment is reported as loss with an unproven cause');
  assert.deepEqual(fault.expected, { byteSize: beforeEntry.byteSize, sha256: beforeEntry.sha256 });
  let verification = await restarted.verifyConsistency();
  assert.equal(verification.valid, false);
  assert.ok(verification.reasons.includes('archive_index_inconsistent'));
  assert.ok(verification.reasons.includes('archive_bytes_unreadable'));

  const persisted = JSON.parse(await fs.readFile(archiveIndex(stateStore.filePath), 'utf8'));
  const persistedFault = persisted.integrityFaults.find((entry) => entry.collection === 'observations' && entry.file === missingName);
  assert.deepEqual(persistedFault, {
    collection: 'observations',
    file: missingName,
    expected: { byteSize: beforeEntry.byteSize, sha256: beforeEntry.sha256 },
    kind: 'missing-segment',
    status: 'missing',
  }, 'the index stores only the deterministic, path-relative evidence projection');
  assert.deepEqual(Object.keys(persistedFault), ['collection', 'file', 'expected', 'kind', 'status'],
    'the durable projection has a fixed key order');
  assert.ok(!JSON.stringify(persistedFault).includes(home), 'the durable evidence contains no absolute home path');
  assert.ok(!persisted.segments.some((entry) => entry.file === missingName), 'the live segment list omits the absent file while durable loss evidence remains');

  const firstLossIndexBytes = await fs.readFile(archiveIndex(stateStore.filePath), 'utf8');
  await appendObservations(restarted, 6, 'after-delete');
  assert.ok(restarted.archiveIntegrity().observations?.some((entry) => entry.kind === 'missing-segment'));
  restarted = await openMemory({ clock: fixedClock });
  assert.ok(restarted.archiveIntegrity().observations?.some((entry) => entry.kind === 'missing-segment'), 'reload preserves the missing-segment evidence');
  const indexAfterReload = await fs.readFile(archiveIndex(stateStore.filePath), 'utf8');
  assert.notEqual(indexAfterReload, firstLossIndexBytes, 'appended archive bytes update the derived index');
  restarted = await openMemory({ clock: fixedClock });
  assert.ok(restarted.archiveIntegrity().observations?.some((entry) => entry.kind === 'missing-segment'), 'a second restart preserves the same evidence');
  assert.equal(await fs.readFile(archiveIndex(stateStore.filePath), 'utf8'), indexAfterReload,
    'an unchanged archive and fixed clock produce byte-identical index documents after restart');
  const finalVerification = await restarted.verifyConsistency();
  assert.deepEqual(finalVerification.archive.faults, restarted.archiveIntegrity(),
    'archiveIntegrity() and verifyConsistency() expose the same integrity fault projection');

  const reusedBytes = await fs.readFile(missingPath).catch(() => null);
  assert.ok(reusedBytes, 'the next rotation reused the deleted highest segment name');
  assert.notEqual(sha256(reusedBytes), beforeEntry.sha256, 'same-name replacement bytes do not prove restoration');
  fault = restarted.archiveIntegrity().observations?.find((entry) => entry.kind === 'missing-segment');
  assert.equal(fault.status, 'replacement-unproven');

  await fs.writeFile(missingPath, originalBytes);
  const recovered = await openMemory({ clock: fixedClock });
  assert.ok(!(recovered.archiveIntegrity().observations ?? []).some((entry) => entry.kind === 'missing-segment'), 'matching size and digest prove the original bytes were restored');
  const recoveredIndex = JSON.parse(await fs.readFile(archiveIndex(stateStore.filePath), 'utf8'));
  assert.equal(recoveredIndex.integrityFaults, undefined, 'proven restoration clears the durable fault');
  assert.ok(recoveredIndex.segments.some((entry) => entry.collection === 'observations' && entry.file === missingName));
  const recoveredVerification = await recovered.verifyConsistency();
  assert.equal(recoveredVerification.archive.valid, true, 'restored bytes remove the live missing-target findings');
  assert.ok(!recoveredVerification.archive.findings.some((finding) => ['archive-index-target-missing', 'archive-loss-evidence'].includes(finding.code)));
  await recovered.compact();
  assert.equal((await recovered.verifyConsistency()).archive.valid, true,
    'a proven restored segment no longer blocks compaction');
});

test('missing-segment evidence survives more than the generic write-fault limit', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-archive-fault-cap-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const stateFile = path.join(home, 'state.json');
  const indexFile = archiveIndex(stateFile);
  const missingName = segmentName(7);
  const missingBytes = Buffer.from('{"id":"missing-original"}\n');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(indexFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-10-26T00:00:00.000Z',
    segments: [{
      collection: 'observations', file: missingName, sealed: true, checksumState: 'final',
      byteSize: missingBytes.length, sha256: sha256(missingBytes),
    }],
  }));

  let currentStateFile = stateFile;
  let aggregate = { evolution: { schema: 4, observations: [], coldArchives: {} } };
  const stateStore = {
    get filePath() { return currentStateFile; },
    async load() { return structuredClone(aggregate); },
    async update(updater) {
      aggregate = updater(aggregate);
      await fs.writeFile(stateFile, JSON.stringify(aggregate));
    },
  };
  const fixedClock = () => new Date('2026-10-26T00:00:00.000Z');
  let failWrites = true;
  const makeMemory = async () => {
    const memory = new EvolutionMemory({
      stateStore,
      hotEntries: 1,
      archiveMaxBytes: 4096,
      clock: fixedClock,
      mutationAuthority: authority,
      archiveWriteGuard: async () => {
        if (failWrites) throw Object.assign(new Error('EIO: simulated archive write failure'), { code: 'EIO' });
      },
    });
    await memory.load();
    return memory;
  };

  const memory = await makeMemory();
  assert.ok(memory.archiveIntegrity().observations?.some((fault) => fault.kind === 'missing-segment'));
  for (let index = 0; index < 18; index += 1) {
    currentStateFile = path.join(home, `fault-${String(index).padStart(2, '0')}.json`);
    await memory.recordObservation({
      id: `write-fault-${index}`,
      type: 'tool/error',
      componentId: 'archive-cap-test',
      message: `unique archive write fault ${index}`,
      forceRecord: true,
    });
  }
  const beforeWrite = memory.archiveIntegrity().observations ?? [];
  assert.equal(beforeWrite.filter((fault) => fault.kind === 'deferred-write').length, 16,
    'the generic write fault pool remains capped at its existing limit');
  assert.ok(beforeWrite.some((fault) => fault.kind === 'missing-segment'),
    'integrity evidence is outside the generic fault cap');

  // The next successful archive write clears ordinary write faults and emits
  // the index. The durable missing-segment evidence must still be present.
  currentStateFile = stateFile;
  failWrites = false;
  await memory.recordObservation({
    id: 'write-after-faults',
    type: 'tool/error',
    componentId: 'archive-cap-test',
    message: 'successful archive write after fault pool',
    forceRecord: true,
  });
  assert.ok(memory.archiveIntegrity().observations?.some((fault) => fault.kind === 'missing-segment'));
  const persisted = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.ok(persisted.integrityFaults?.some((fault) => fault.collection === 'observations' && fault.file === missingName),
    'an index write after ordinary faults cannot erase missing-segment evidence');

  const reloaded = await makeMemory();
  assert.ok(reloaded.archiveIntegrity().observations?.some((fault) => fault.kind === 'missing-segment'),
    'the evidence survives a reload after the pool overflow');
  const restarted = await makeMemory();
  assert.ok(restarted.archiveIntegrity().observations?.some((fault) => fault.kind === 'missing-segment'),
    'the evidence survives a second restart after the pool overflow');
});

test('rotation, completed compaction, and interrupted transitions do not create permanent missing-segment faults', async (t) => {
  const { home, stateStore, openMemory } = await officialHome(t);
  const memory = await openMemory();
  await appendObservations(memory, 12, 'normal');
  assert.ok(!(memory.archiveIntegrity().observations ?? []).some((entry) => entry.kind === 'missing-segment'));
  await memory.compact();
  const completed = await openMemory();
  assert.ok(!(completed.archiveIntegrity().observations ?? []).some((entry) => entry.kind === 'missing-segment'));

  await appendObservations(completed, 12, 'after-compact');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  const missingName = names.at(-1);
  await fs.rm(path.join(segmentDirectory(stateStore.filePath), missingName));
  await fs.writeFile(`${observationArchive(stateStore.filePath)}.compact-interrupted.bak`, 'old tree marker');
  const interrupted = await openMemory();
  const interruptedFault = interrupted.archiveIntegrity().observations?.find((entry) => entry.kind === 'missing-segment-undetermined');
  assert.ok(interruptedFault, 'a compaction backup classifies the target as an incomplete transition');
  assert.ok(!JSON.parse(await fs.readFile(archiveIndex(stateStore.filePath), 'utf8')).integrityFaults?.length,
    'the incomplete compaction did not persist permanent-loss evidence');
  const interruptedVerification = await interrupted.verifyConsistency();
  assert.equal(interruptedVerification.valid, false);
  assert.equal(interruptedVerification.archive.status, 'incomplete-transition');

  await fs.rm(`${observationArchive(stateStore.filePath)}.compact-interrupted.bak`);
  const domainGlobalPath = path.join(home, 'storages', 'evolution_domain.json');
  await fs.writeFile(domainGlobalPath, JSON.stringify({ global: { pending: { stage: 'stage-in-progress' } } }));
  const pending = await openMemory();
  assert.ok(pending.archiveIntegrity().observations?.some((entry) => entry.kind === 'missing-segment-undetermined'));
  assert.ok(!JSON.parse(await fs.readFile(archiveIndex(stateStore.filePath), 'utf8')).integrityFaults?.length,
    'a pending domain install also stays provisional');
});

test('compact refuses a corrupt sealed segment and preserves its bytes exactly', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const memory = await openMemory();
  await appendObservations(memory, 12, 'corrupt');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  const segmentPath = path.join(segmentDirectory(stateStore.filePath), names[0]);
  const corruptLine = Buffer.from('{"id":"unparseable","payload":\n');
  await fs.appendFile(segmentPath, corruptLine);
  const before = await fs.readFile(segmentPath);
  memory.history('observations');
  assert.ok(memory.archiveIntegrity().observations?.some((entry) => entry.kind === 'invalid-line'));

  await assert.rejects(memory.compact(), (error) => error?.code === 'E_ARCHIVE_REWRITE_UNSAFE');
  assert.deepEqual(await fs.readFile(segmentPath), before, 'refused compaction leaves the sealed segment byte-identical');
  const restarted = await openMemory();
  restarted.history('observations');
  assert.ok(restarted.archiveIntegrity().observations?.some((entry) => entry.kind === 'invalid-line'));
});

test('compact rejects a lengthened sealed digest conflict without rewriting either source, then succeeds after trusted restoration', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const fixedClock = () => new Date('2026-10-26T00:00:00.000Z');
  const memory = await openMemory({ clock: fixedClock });
  await appendObservations(memory, 12, 'sealed-digest-conflict');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  assert.ok(names.length > 0, 'the fixture must contain a sealed segment');
  const segmentName = names[0];
  const segmentPath = path.join(segmentDirectory(stateStore.filePath), segmentName);
  const indexFile = archiveIndex(stateStore.filePath);
  const originalIndexBytes = await fs.readFile(indexFile);
  const originalEntry = JSON.parse(originalIndexBytes.toString('utf8')).segments
    .find((entry) => entry.collection === 'observations' && entry.file === segmentName);
  const { originalBytes, changedBytes } = await appendValidLineToSealedObservation(segmentPath);
  assert.ok(changedBytes.length > originalBytes.length);
  const beforeRefusal = await archiveTreeBytes(stateStore.filePath);
  const preRefusalVerification = await memory.verifyConsistency();
  const preRefusalByReason = Object.fromEntries(preRefusalVerification.archive.mismatched.map((entry) => [entry.reason, entry]));
  assert.equal(preRefusalByReason.byte_size.expected, originalEntry.byteSize);
  assert.equal(preRefusalByReason.byte_size.actual, changedBytes.length);
  assert.equal(preRefusalByReason.checksum.expected, originalEntry.sha256);
  assert.equal(preRefusalByReason.checksum.actual, sha256(changedBytes));

  await assert.rejects(memory.compact(), (error) => error?.code === 'E_ARCHIVE_REWRITE_UNSAFE'
    && error.message.includes('archive-sealed-size-mismatch')
    && error.message.includes('archive-sealed-digest-mismatch')
    && error.message.includes(`observations/${segmentName}`));
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal,
    'the refusal leaves all archive files and the index byte-identical');

  const firstRestart = await openMemory({ clock: fixedClock });
  const secondRestart = await openMemory({ clock: fixedClock });
  assert.equal((await firstRestart.verifyConsistency()).valid, false, 'the first restart retains the integrity finding');
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal,
    'repeated loads do not reach the full index writer or replace the expected digest');
  const persisted = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  const persistedEntry = persisted.segments.find((entry) => entry.collection === 'observations' && entry.file === segmentName);
  assert.equal(persistedEntry.sha256, originalEntry.sha256);
  assert.equal(persistedEntry.byteSize, originalEntry.byteSize);
  assert.deepEqual(await fs.readFile(segmentPath), changedBytes);

  const verification = await secondRestart.verifyConsistency();
  assert.equal(verification.valid, false);
  const byReason = Object.fromEntries(verification.archive.mismatched.map((entry) => [entry.reason, entry]));
  assert.equal(byReason.byte_size.expected, originalEntry.byteSize);
  assert.equal(byReason.byte_size.actual, changedBytes.length);
  assert.equal(byReason.checksum.expected, originalEntry.sha256);
  assert.equal(byReason.checksum.actual, sha256(changedBytes));

  await fs.writeFile(segmentPath, originalBytes);
  const restored = await secondRestart.verifyConsistency();
  assert.equal(restored.valid, true, 'the same instance sees trusted restored bytes');
  await secondRestart.compact();
  assert.equal((await secondRestart.verifyConsistency()).valid, true, 'the same instance can compact after restoration');
});

test('compact rejects an equal-length sealed digest conflict without rewriting its bytes or index', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const fixedClock = () => new Date('2026-10-26T00:00:00.000Z');
  const memory = await openMemory({ clock: fixedClock });
  await appendObservations(memory, 12, 'equal-length-digest');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  assert.ok(names.length > 0, 'the fixture must contain a sealed segment');
  const segmentPath = path.join(segmentDirectory(stateStore.filePath), names[0]);
  const indexFile = archiveIndex(stateStore.filePath);
  const originalBytes = await fs.readFile(segmentPath);
  const originalText = originalBytes.toString('utf8');
  const idMatch = originalText.match(/"id":"(equal-length-digest-\d+)"/);
  assert.ok(idMatch, 'the selected segment contains a known record id');
  const oldId = idMatch[1];
  const lastDigit = Number(oldId.at(-1));
  const newId = `${oldId.slice(0, -1)}${(lastDigit + 1) % 10}`;
  const changedBytes = Buffer.from(originalText.replace(idMatch[0], `"id":"${newId}"`));
  assert.equal(changedBytes.length, originalBytes.length, 'the edit preserves the sealed segment byte size');
  for (const line of changedBytes.toString('utf8').trimEnd().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  await fs.writeFile(segmentPath, changedBytes);
  const indexBytesBefore = await fs.readFile(indexFile);
  const beforeRefusal = await archiveTreeBytes(stateStore.filePath);

  await assert.rejects(memory.compact(), (error) => error?.code === 'E_ARCHIVE_REWRITE_UNSAFE'
    && error.message.includes('archive-sealed-digest-mismatch'));
  assert.deepEqual(await fs.readFile(segmentPath), changedBytes, 'refusal leaves the equal-length tampered segment untouched');
  assert.deepEqual(await fs.readFile(indexFile), indexBytesBefore, 'refusal leaves the expected index bytes untouched');
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal, 'refusal leaves the entire archive tree unchanged');
});

test('compact preserves an index that becomes unreadable after load', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const memory = await openMemory();
  await appendObservations(memory, 12, 'index-invalid-after-load');
  const indexFile = archiveIndex(stateStore.filePath);
  const corrupt = Buffer.from('{"schemaVersion":1,"segments":');
  await fs.writeFile(indexFile, corrupt);
  const beforeRefusal = await archiveTreeBytes(stateStore.filePath);

  await assert.rejects(memory.compact(), (error) => error?.code === 'E_ARCHIVE_INDEX_STATE_UNKNOWN');
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal,
    'compaction does not change archive segments or the unreadable index');
  assert.deepEqual(await fs.readFile(indexFile), corrupt, 'the unreadable index bytes remain in place');

  await assert.rejects(openMemory(), (error) => error?.code === 'E_ARCHIVE_INDEX_STATE_UNKNOWN');
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal,
    'a later startup still sees the same unreadable index and archive bytes');
});

test('finalizeKnowledge rejects a sealed digest conflict without rewriting archive history', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const fixedClock = () => new Date('2026-10-26T00:00:00.000Z');
  const memory = await openMemory({ clock: fixedClock });
  await appendObservations(memory, 12, 'finalize-digest-conflict');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  const segmentName = names[0];
  const segmentPath = path.join(segmentDirectory(stateStore.filePath), segmentName);
  await appendValidLineToSealedObservation(segmentPath);
  const beforeRefusal = await archiveTreeBytes(stateStore.filePath);

  await assert.rejects(memory.finalizeKnowledge({
    winner: { id: 'trusted-winner', capabilityId: 'archive-defect-test', candidateFingerprint: 'winner-fingerprint' },
    before: {}, after: { qualityScore: 1 }, validation: { validationRuns: 1 }, outcome: 'SUCCESS',
  }), (error) => error?.code === 'E_ARCHIVE_REWRITE_UNSAFE'
    && error.message.includes('archive-sealed-size-mismatch')
    && error.message.includes('archive-sealed-digest-mismatch'));
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal,
    'knowledge finalization cannot replace the archive or its expected digest after a conflict');
});

test('compact refuses a missing sealed target and preserves its loss evidence', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const memory = await openMemory();
  await appendObservations(memory, 12, 'missing-sealed-target');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  const missingName = names[0];
  const missingPath = path.join(segmentDirectory(stateStore.filePath), missingName);
  const originalBytes = await fs.readFile(missingPath);
  await fs.rm(missingPath);
  const beforeRefusal = await archiveTreeBytes(stateStore.filePath);

  await assert.rejects(memory.compact(), (error) => error?.code === 'E_ARCHIVE_REWRITE_UNSAFE'
    && (error.message.includes('archive-index-target-missing') || error.message.includes('archive-loss-evidence')));
  assert.deepEqual(await archiveTreeBytes(stateStore.filePath), beforeRefusal,
    'compaction leaves the index expectation and every remaining archive byte untouched');
  assert.equal(await fs.stat(missingPath).then(() => true, () => false), false);

  await fs.writeFile(missingPath, originalBytes);
  const restored = await memory.verifyConsistency();
  assert.equal(restored.archive.valid, true);
  assert.ok(!restored.archive.findings.some((finding) => ['archive-index-target-missing', 'archive-loss-evidence'].includes(finding.code)));
  await memory.compact();
  assert.equal((await memory.verifyConsistency()).archive.valid, true, 'correct bytes clear the refusal and compaction succeeds');
});

test('an unreadable archive index is preserved instead of rebuilt over unknown state', async (t) => {
  const { stateStore, openMemory } = await officialHome(t);
  const memory = await openMemory();
  await appendObservations(memory, 12, 'index-corrupt');
  const indexFile = archiveIndex(stateStore.filePath);
  const corrupt = Buffer.from('{"schemaVersion":1,"segments":');
  await fs.writeFile(indexFile, corrupt);
  await assert.rejects(openMemory(), (error) => error?.code === 'E_ARCHIVE_INDEX_STATE_UNKNOWN');
  assert.deepEqual(await fs.readFile(indexFile), corrupt, 'unknown index bytes remain unchanged');
});

test('doctor and runtime consume the same read-only archive classifier result', async (t) => {
  const { home, dataRoot, stateStore, domain, openMemory } = await officialHome(t);
  const memory = await openMemory();
  await appendObservations(memory, 12, 'shared-classifier');
  const names = (await fs.readdir(segmentDirectory(stateStore.filePath))).filter((name) => /^segment-[0-9]+\.jsonl$/.test(name)).sort();
  await fs.rm(path.join(segmentDirectory(stateStore.filePath), names[0]));
  const diagnosed = await openMemory();
  const globalPath = path.join(home, 'storages', 'evolution_domain.json');
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, JSON.stringify({ unit: { name: 'evolution_domain', version: 1 }, global: domain.global.get(), tables: {} }));

  const runtime = await diagnosed.verifyConsistency();
  const report = await runDiagnostics({ dshHome: home, probe: false });
  const doctor = report.checks.find((entry) => entry.id === 'state.archives').evidence.dockyard.archiveIntegrity;
  assert.deepEqual(runtime.archive.findings, doctor.findings);
  assert.equal(runtime.archive.status, doctor.status);
  assert.equal(dataRoot, resolveEvolutionPaths({ dshHome: home }).dataRoot);
});

test('staged domain installs preserve missing-segment evidence in the archive index', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-archive-staged-install-'));
  const dataRoot = path.join(home, 'storages', 'evolution');
  const stateFile = path.join(dataRoot, 'dockyard', 'state.json');
  const activeFile = observationArchive(stateFile);
  const segmentDir = segmentDirectory(stateFile);
  await fs.mkdir(segmentDir, { recursive: true });
  const segment = Buffer.from('{"id":"existing-cold"}\n');
  const active = Buffer.from('');
  await fs.writeFile(path.join(segmentDir, segmentName(1)), segment);
  await fs.writeFile(activeFile, active);
  const indexDocument = {
    schemaVersion: 1,
    segments: [
      { collection: 'observations', file: segmentName(1), sealed: true, checksumState: 'final', byteSize: segment.length, sha256: sha256(segment) },
      { collection: 'observations', file: segmentName(2), sealed: true, checksumState: 'final', byteSize: 52, sha256: 'c'.repeat(64) },
      { collection: 'observations', file: path.basename(activeFile), sealed: false, checksumState: 'provisional', byteSize: 0, sha256: null },
    ],
  };
  const indexFile = archiveIndex(stateFile);
  await fs.writeFile(indexFile, JSON.stringify(indexDocument));
  const observations = Array.from({ length: 52 }, (_, index) => ({
    id: `seed-${index}`, type: 'tool/result', code: 'SEED', message: 'seeded', componentId: `plugin:seed-${index}`,
    severity: 'info', status: 'observed', success: true, recordedAt: '2026-10-26T00:00:00.000Z',
  }));
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ evolution: { schema: 4, observations } }));

  const backend = new JsonStorageBackend(path.join(home, 'official-json-backend'));
  const ctx = {
    emit() {}, effect() {}, logger: { warn() {}, error() {}, info() {} },
    storage: { backend: { get() { return backend; } } },
  };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  let port;
  t.after(async () => {
    await port?.close();
    await backend.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  port = await openDomainStorage(ctx, {
    presetDir: dataRoot,
    eventBridgePath: path.join(dataRoot, 'execution-events.jsonl'),
    eventBridgeKey: 'd'.repeat(64),
    domainSeed: true,
  });
  let persisted = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.ok(persisted.integrityFaults?.some((fault) => fault.file === segmentName(2)), 'startup persists the missing target before the stage begins');

  await port.observe({ type: 'tool/result', code: 'AFTER-SEED', message: 'staged update', componentId: 'plugin:staged', severity: 'info', status: 'observed', success: true });
  persisted = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  assert.ok(persisted.integrityFaults?.some((fault) => fault.collection === 'observations' && fault.file === segmentName(2)), 'the staged install carries the same fault document forward');
});

test('a missing coldArchives count is derived from archive evidence', async (t) => {
  const { stateStore, domain, openMemory } = await officialHome(t);
  const current = domain.global.get();
  await domain.global.set({
    ...current,
    aggregate: { evolution: { schema: 4, observations: [], knowledge: [] } },
  });
  await fs.mkdir(path.dirname(stateStore.filePath), { recursive: true });
  const archive = observationArchive(stateStore.filePath);
  await fs.writeFile(archive, '{"id":"cold-existing","type":"component/observation"}\n');

  const memory = await openMemory({ archiveMaxBytes: 1024 });
  assert.equal(Object.hasOwn(memory.snapshot().coldArchives.observations, 'count'), false, 'fixture metadata has no count');
  assert.equal(memory.hasColdHistory, true, 'present archive bytes make a missing count unknown rather than zero');
  assert.ok(memory.history('observations').some((entry) => entry.id === 'cold-existing'));
});
