// Why the transaction-start document validation cannot be replaced by a
// cheaper check (2026-10-24 hot-path round, rejected candidate).
//
// The candidate: `installPending()` skips its unconditional `schema.parse()` of
// the live document when the handle still returns the exact object this port
// last published. The argument for it was that the document was validated when
// it was published, and that anything a writer installs through `set()` is a
// new object, so the identity check separates "validated by us" from "not".
//
// These tests are the counterexample. The official handle's `get()` returns the
// live value, so an in-process holder of the same open domain
// (`ctx.storageDomain.get(name).global`) can edit that object *in place*: the
// identity is unchanged and the document is invalid, and no `set()` happens, so
// nothing the transaction compares against its own baseline notices. The
// publication that follows is not a substitute for refusing at the entry:
//
//  - `aggregate.evolution.schema = 3` is below the durable minimum the schemas
//    enforce, but `EvolutionMemory#load` clamps a loaded schema with
//    `Math.max(4, ...)`, so the aggregate the transaction publishes is legal and
//    the illegal value is *washed out* instead of refused;
//  - a top-level `schema` or an unknown top-level key is not carried into the
//    document the transaction publishes at all (that publication is built from
//    literals plus the snapshot), so it is dropped rather than refused;
//  - a marker value that is not a string *is* refused by the publication's
//    `schema.parse`, but only after the stage mirror and `work()` have run: the
//    refusal leaves an orphaned stage directory behind where the entry parse
//    refused before anything was created. Same durable bytes, different scene.
//
// So the entry parse is load-bearing and this file pins it against the live
// handle: every shape below must be refused with the durable tree byte-identical
// and no staging directory created, and the same workload must then commit
// exactly once after the document is repaired. Re-introducing an identity-based
// skip of that parse makes the first three shapes commit and the fourth leave a
// stage behind, which fails the assertions here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { COUNTEREXAMPLE_SHAPES, deriveCandidate } from './domain-hotpath-20261024-candidate.js';
import { materializeDomainStorage } from './domain-storage-baseline.js';
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const KEY = 'b'.repeat(64);

async function fixture(root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-entry-validation-'))) {
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  return { root, ctx, config, backend };
}

async function teardown(f) { await f.backend.close(); fs.rmSync(f.root, { recursive: true, force: true }); }

/** Every durable byte of the port plus the name of every staged directory. */
function durableState(root) {
  const files = {};
  const walk = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relative && name === 'domain-archive.lock') continue;
      const absolute = path.join(directory, name);
      const nested = relative ? `${relative}/${name}` : name;
      if (fs.statSync(absolute).isDirectory()) walk(absolute, nested);
      else files[nested] = fs.readFileSync(absolute, 'base64');
    }
  };
  walk(root, '');
  const staging = path.join(root, 'domain-staging');
  return { files, staged: fs.existsSync(staging) ? fs.readdirSync(staging).sort() : [] };
}

const OBSERVATION = { code: 'HOST_OPERATION_FAILED', target: 'plugin:hotpath' };

/** The number of committed observation rows in the durable document. */
function observationRows(root) {
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'official', 'evolution_domain.json'), 'utf8')).global;
  const rows = stored.aggregate?.evolution?.observations;
  return Array.isArray(rows) ? rows.length : 0;
}

for (const [name, scenario] of Object.entries(COUNTEREXAMPLE_SHAPES)) {
  test(`an in-place document edit is refused at the entry: ${name}`, async () => {
    const f = await fixture();
    try {
      const port = await openDomainStorage(f.ctx, f.config);
      try {
        await port.observe(OBSERVATION);
        const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
        const document = domain.global.get();
        const before = durableState(f.root);
        scenario.edit(document);
        // The exact object the port published, edited in place: identity-based
        // skipping cannot see this, and `set()` was never called.
        assert.equal(domain.global.get(), document, 'the scenario edits the live document, not a copy');
        const edited = durableState(f.root);
        assert.deepEqual(edited.files, before.files, 'the in-place edit itself is not durable until a transaction reads it');

        const rowsBefore = observationRows(f.root);
        await assert.rejects(port.observe(OBSERVATION), (error) => {
          // The refusal has to be the entry document check, not any other error:
          // the issue code and path are the ones this shape's schema violation
          // produces, so a different boundary (or a downstream failure) fails here.
          assert.equal(error.name, 'ZodError', `${name}: the refusal must come from the document schema`);
          const issues = error.issues ?? [];
          assert.ok(issues.some((issue) => issue.code === scenario.issue.code
            && JSON.stringify(issue.path) === JSON.stringify(scenario.issue.path)),
          `${name}: expected entry issue ${JSON.stringify(scenario.issue)} but saw ${JSON.stringify(issues.map((issue) => ({ code: issue.code, path: issue.path })))}`);
          return true;
        }, 'the transaction must be refused instead of publishing a document it could not validate');
        const after = durableState(f.root);
        assert.deepEqual(after.files, before.files, 'a refused transaction writes no durable byte');
        assert.deepEqual(after.staged, before.staged, 'and creates no stage, so the entry refused before any work');
        assert.deepEqual(after.staged, [], 'the refusal happens before the stage mirror exists');

        // The workload itself is fine: repairing the document in place makes the
        // same call commit exactly once, so the refusal was about the document.
        assert.equal(observationRows(f.root), rowsBefore, 'the refusal recorded no observation');
        scenario.repair(document);
        await port.observe(OBSERVATION);
        const committed = JSON.parse(fs.readFileSync(path.join(f.root, 'official', 'evolution_domain.json'), 'utf8')).global;
        assert.equal(committed.pending, null, 'the commit published no pending record');
        assert.equal(observationRows(f.root), rowsBefore + 1,
          'the retried observation was committed exactly once, so the refusal consumed nothing');
      } finally {
        await port.close().catch(() => {});
      }
    } finally { await teardown(f); }
  });
}

test('a repaired document commits exactly once, so the refusal did not consume the record', async () => {
  const f = await fixture();
  try {
    const port = await openDomainStorage(f.ctx, f.config);
    try {
      await port.observe(OBSERVATION);
      const rowsAfterFirst = observationRows(f.root);
      const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
      const document = domain.global.get();
      document.aggregate.evolution.schema = 3;
      await assert.rejects(port.observe(OBSERVATION), (error) => error.name === 'ZodError');
      assert.equal(observationRows(f.root), rowsAfterFirst, 'the refused record is not committed');
      document.aggregate.evolution.schema = 4;
      await port.observe(OBSERVATION);
      assert.equal(observationRows(f.root), rowsAfterFirst + 1,
        'the repaired retry commits exactly one row, so the refused attempt was neither applied nor lost');
      await port.observe({ code: 'HOST_OPERATION_FAILED', target: 'plugin:hotpath:second' });
      assert.equal(observationRows(f.root), rowsAfterFirst + 2,
        'and a later observation still commits exactly once after the refusal');
    } finally { await port.close().catch(() => {}); }
  } finally { await teardown(f); }
});

/**
 * The same scenario against the rejected candidate, as a running differential.
 *
 * The test above pins what the working tree does; this one pins *why* it has to:
 * the candidate's skip is derived from the working source by
 * `domain-hotpath-20261024-candidate.js`, materialised as a real module, and run
 * through exactly the same fixture. It must commit the three shapes whose illegal
 * value is dropped when the transaction re-generates the document, and it must
 * leave a stage directory behind for the fourth, where the working tree refused
 * before creating one. If a future round reintroduces the skip, the two sides
 * stop diverging and this fails.
 */
test('the rejected identity skip publishes documents the working tree refuses', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-entry-candidate-'));
  try {
    const source = fs.readFileSync(new URL('../../lib/domain-storage.js', import.meta.url), 'utf8');
    const candidate = await materializeDomainStorage(deriveCandidate(source), home, 'candidate');
    // The derivation must produce a working module, not a lookalike: without the
    // skip it would behave exactly like the working tree and the assertions below
    // would be meaningless.
    for (const [name, shape] of Object.entries(COUNTEREXAMPLE_SHAPES)) {
      const root = path.join(home, name);
      fs.mkdirSync(root, { recursive: true });
      const f = await fixture(root);
      const port = await candidate.openDomainStorage(f.ctx, f.config);
      try {
        await port.observe(OBSERVATION);
        const before = durableState(root);
        const document = f.ctx.storageDomain.get(evolutionDomainSpec.name).global.get();
        shape.edit(document);
        let refused = false;
        try { await port.observe(OBSERVATION); } catch { refused = true; }
        const after = durableState(root);
        if (shape.washedOut) {
          assert.equal(refused, false, `${name}: the candidate must publish despite the invalid document`);
          assert.notDeepEqual(after.files, before.files, `${name}: the candidate commits a changed document`);
        } else {
          assert.equal(refused, true, `${name}: the publication parse still refuses this one`);
          // The refusal lands after the commit token was advanced and after the
          // stage mirror was created: the document is unchanged, but the token and
          // the leftover stage are - which is exactly the scene difference the
          // entry parse removes (the same shape in the working tree changes no file
          // and creates no stage).
          assert.equal(after.files['official/evolution_domain.json'], before.files['official/evolution_domain.json'],
            `${name}: the refused publication writes no document`);
          assert.ok(after.staged.length > 0,
            `${name}: but only after the stage mirror exists`);
        }
      } finally {
        await port.close().catch(() => {});
        await f.backend.close();
      }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
