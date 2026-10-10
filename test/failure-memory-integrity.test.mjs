// Failure-path tests for the file-backed failure memory.
//
// The durable memory is user data that survives install, uninstall and
// reinstall, so damaged or partial input must fail safe: an unusable record is
// quarantined with its original bytes, a record restored without an identity is
// never merged with a different record, and the record written by `record()` is
// never trimmed away by its own retention pass. Every fixture is synthetic and
// lives in os.tmpdir(); nothing here reads a real DSH home or real memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EvolutionMemory } from '../lib/orchestrator.js';

function freshFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evo-memory-${name}-`));
  return { dir, file: path.join(dir, 'evolution-memory.json') };
}

const record = (overrides = {}) => ({
  signature: 'sig-1',
  count: 1,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  problem: 'stored failure',
  evidence: {},
  experiment: {},
  result: {},
  prevention: 'keep the evidence',
  ...overrides,
});

test('a record that is not an object quarantines the file instead of failing startup', () => {
  const { dir, file } = freshFile('nonobject');
  const original = '{"schema":1,"entries":[null]}';
  fs.writeFileSync(file, original);

  const memory = new EvolutionMemory({ file });

  assert.deepEqual(memory.snapshot().entries, []);
  assert.equal(memory.quarantine?.reason, 'entry-failure');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries, []);
  const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.quarantine-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), original, 'the damaged bytes are preserved');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('one unusable record quarantines the whole file instead of silently dropping part of it', () => {
  const { dir, file } = freshFile('mixed');
  const original = JSON.stringify({ schema: 1, entries: [record(), 42] });
  fs.writeFileSync(file, original);

  const memory = new EvolutionMemory({ file });

  assert.deepEqual(memory.snapshot().entries, []);
  assert.equal(memory.quarantine?.reason, 'entry-failure');
  const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.quarantine-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), original, 'the damaged bytes are preserved');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a record nested past the load bound is quarantined, never a startup overflow', () => {
  const { dir, file } = freshFile('deep');
  const deep = '{"a":'.repeat(3000) + '1' + '}'.repeat(3000);
  const original = `{"schema":1,"entries":[{"id":"deep","payload":${deep}}]}`;
  fs.writeFileSync(file, original);

  const memory = new EvolutionMemory({ file });

  assert.deepEqual(memory.snapshot().entries, []);
  assert.equal(memory.quarantine?.reason, 'entry-failure');
  const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.quarantine-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), original, 'the deep bytes are preserved');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('records within the load bound still load', () => {
  const { dir, file } = freshFile('bounded-depth');
  let payload = 1;
  for (let level = 0; level < 32; level += 1) payload = { a: payload };
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [{ id: 'ok', payload }] }));

  const memory = new EvolutionMemory({ file });

  assert.equal(memory.snapshot().entries.length, 1);
  assert.equal(memory.quarantine, null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('records at the depth bound keep distinct identities', () => {
  const { dir, file } = freshFile('bound-agreement');
  const entryAt = (levels, leaf) => {
    let value = leaf;
    for (let level = 0; level < levels; level += 1) value = { a: value };
    return { id: 'same', payload: value };
  };
  // The deepest value sits at depth 64: the loader accepts these, so the
  // content-derived identity has to keep telling them apart.
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [entryAt(63, 1), entryAt(63, 2)] }));
  const memory = new EvolutionMemory({ file });
  assert.equal(memory.snapshot().entries.length, 2);
  assert.equal(new Set(memory.snapshot().entries.map((item) => item.signature)).size, 2);

  // One level deeper is damaged input and quarantines the file instead.
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [entryAt(64, 1), entryAt(64, 2)] }));
  const deeper = new EvolutionMemory({ file });
  assert.deepEqual(deeper.snapshot().entries, []);
  assert.equal(deeper.quarantine?.reason, 'entry-failure');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-string explicit signature is normalized instead of breaking retention', () => {
  const { dir, file } = freshFile('non-string-signature');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [record({ signature: 'future', lastSeenAt: '9999-12-31T23:59:59.999Z' })] }));

  const memory = new EvolutionMemory({ file, maxEntries: 1 });
  const result = memory.record({ signature: 42, problem: 'numeric signature', evidence: {}, experiment: {}, result: {}, prevention: 'x' });

  assert.equal(typeof result.entry?.signature, 'string', 'record() must return a string-signed entry');
  assert.equal(memory.snapshot().entries[0].problem, 'numeric signature');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].problem, 'numeric signature');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('records restored without an identity are kept apart instead of merged', () => {
  const { dir, file } = freshFile('no-signature');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [{ id: 'first' }, { id: 'second' }] }));

  const memory = new EvolutionMemory({ file });
  const entries = memory.snapshot().entries;

  assert.equal(entries.length, 2, 'two different records must not collapse into one');
  assert.equal(new Set(entries.map((item) => item.signature)).size, 2);
  for (const item of entries) assert.equal(typeof item.signature, 'string');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('identical identity-less records still deduplicate', () => {
  const { dir, file } = freshFile('no-signature-duplicate');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [{ id: 'same' }, { id: 'same' }] }));

  const memory = new EvolutionMemory({ file });

  assert.equal(memory.snapshot().entries.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a derived identity is stable across reloads', () => {
  const { dir, file } = freshFile('stable');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [{ id: 'only' }] }));

  const first = new EvolutionMemory({ file });
  first.compact({ save: true });
  const second = new EvolutionMemory({ file });

  assert.deepEqual(second.snapshot().entries, first.snapshot().entries);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a skewed clock cannot trim the record that was just written', () => {
  const { dir, file } = freshFile('skew');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [record({ signature: 'future', lastSeenAt: '9999-12-31T23:59:59.999Z' })] }));

  const memory = new EvolutionMemory({ file, maxEntries: 1 });
  const result = memory.record({ problem: 'new failure', evidence: {}, experiment: {}, result: {}, prevention: 'x' });

  assert.equal(typeof result.entry?.signature, 'string', 'record() must return the entry it wrote');
  assert.equal(result.duplicate, false);
  const entries = memory.snapshot().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].problem, 'new failure', 'the new failure survives and the oldest record is evicted');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].problem, 'new failure');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('exceeding the bound still trims the oldest records on a normal timeline', () => {
  const { dir, file } = freshFile('bounded');
  const memory = new EvolutionMemory({ file, maxEntries: 2 });
  for (const problem of ['one', 'two', 'three']) memory.record({ problem, evidence: {}, experiment: {}, result: {}, prevention: 'x' });

  assert.deepEqual(memory.snapshot().entries.map((item) => item.problem), ['two', 'three']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('duplicate records still count up and keep their first-seen context', () => {
  const { dir, file } = freshFile('duplicate');
  const memory = new EvolutionMemory({ file });
  const payload = {
    problem: 'same failure',
    evidence: { at: 'T1' },
    experiment: { id: 'exp-1', target: 'plugin:probe' },
    result: { category: 'revert', rollback: { at: 'T1' } },
    prevention: 'retain verified rollback evidence',
  };
  memory.record(payload);
  const first = memory.snapshot().entries[0];

  const result = memory.record({
    ...payload,
    evidence: { at: 'T2' },
    experiment: { id: 'exp-2', target: 'plugin:probe' },
    result: { category: 'revert', rollback: { at: 'T2' } },
  });

  assert.equal(result.duplicate, true);
  const entries = memory.snapshot().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);
  assert.equal(entries[0].firstSeenAt, first.firstSeenAt, 'first-seen time is preserved');
  assert.equal(entries[0].experiment.id, 'exp-1', 'the mode identity stays the one the signature was derived from');
  assert.equal(entries[0].evidence.at, 'T2', 'the latest evidence replaces the earlier one');

  fs.rmSync(dir, { recursive: true, force: true });
});
