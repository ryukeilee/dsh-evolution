// Supersession is an operator annotation on already-verified publication
// records, not a second promotion engine. These tests pin the one place a
// consumer may let one stable record yield to another, and the closed shape of
// the annotation itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  SHARED_STATUS,
  annotateSharedRecord,
  applySupersession,
  publishSharedRecord,
  readDisableState,
  readSharedIndex,
  revokeSharedSupersession,
  validateSharedRecord,
} from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const OLD = 'evolution-promoted-aaaaaaaaaaaa';
const NEW = 'evolution-promoted-bbbbbbbbbbbb';

function marker(overrides = {}) {
  return {
    recordId: NEW,
    sourceSha256: 'b'.repeat(64),
    approvalSha256: 'c'.repeat(64),
    evidenceSha256: 'd'.repeat(64),
    at: '2026-11-24T15:00:00.000Z',
    ...overrides,
  };
}

function supersededBy(overrides = {}) {
  return { acp: marker(overrides) };
}

function pair({ replacementStatus = 'eligible', replacementSource = 'b'.repeat(64), replacementSuperseded = false, oldMarker = supersededBy() } = {}) {
  const old = { id: OLD, sourceSha256: 'a'.repeat(64), ...(oldMarker ? { supersededBy: oldMarker } : {}) };
  const replacement = {
    id: NEW,
    sourceSha256: replacementSource,
    ...(replacementSuperseded ? { supersededBy: supersededBy({ recordId: OLD, sourceSha256: 'a'.repeat(64) }) } : {}),
  };
  return [
    { record: old, decision: { status: 'eligible' } },
    { record: replacement, decision: { status: replacementStatus } },
  ];
}

test('a verified replacement suppresses the record it improves within one index snapshot', () => {
  const [old, replacement] = applySupersession(pair(), { profile: 'acp' });
  assert.equal(old.decision.status, SHARED_STATUS.DISABLED);
  assert.equal(old.decision.reason, 'superseded-by');
  assert.equal(old.decision.supersededBy, NEW);
  assert.equal(replacement.decision.status, 'eligible', 'the replacement stays mounted');
});

test('an ineligible replacement never takes the previous record down', () => {
  for (const status of ['pending-revalidation', 'skipped-incompatible', 'failed', 'skipped-invalid']) {
    const [old] = applySupersession(pair({ replacementStatus: status }), { profile: 'acp' });
    assert.equal(old.decision.status, 'eligible', status);
  }
});

test('supersession is profile-scoped and digest-bound', () => {
  const [otherProfile] = applySupersession(pair(), { profile: 'web' });
  assert.equal(otherProfile.decision.status, 'eligible');
  const [changedBytes] = applySupersession(pair({ replacementSource: 'e'.repeat(64) }), { profile: 'acp' });
  assert.equal(changedBytes.decision.status, 'eligible', 'different bytes cannot inherit the approval');
  const [unmarked] = applySupersession(pair({ oldMarker: null }), { profile: 'acp' });
  assert.equal(unmarked.decision.status, 'eligible');
  const [chained] = applySupersession(pair({ replacementSuperseded: true }), { profile: 'acp' });
  assert.equal(chained.decision.status, 'eligible', 'a chain cannot hide both records');
  assert.deepEqual(applySupersession(pair(), { profile: 'desktop' })[0].decision, { status: 'eligible' });
});

async function recordFixture(t, id = OLD, existingRoot = null) {
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'evo-supersession-'));
  if (!existingRoot) t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, 'promoted');
  const pluginName = `dsh-${id}`;
  const pluginDir = path.join(pluginRoot, pluginName, 'lib');
  await fs.mkdir(pluginDir, { recursive: true });
  const modulePath = path.join(pluginDir, 'index.js');
  const source = `export const name = ${JSON.stringify(id)};\nexport const inject = [];\nexport function apply() {}\n`;
  await fs.writeFile(modulePath, source);
  await fs.writeFile(path.join(pluginRoot, pluginName, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  const paths = { dataRoot: root, pluginRoot };
  const record = {
    id, schemaVersion: 1, experimentId: `exp-${id.slice(-4)}`, pluginName, moduleUrl: pathToFileURL(modulePath).href,
    entry: 'lib/index.js', sourceSha256: HEX(source),
    manifestSha256: HEX(await fs.readFile(path.join(pluginRoot, pluginName, 'package.json'))),
    publisherProfile: 'desktop', approvedProfiles: ['acp'],
    stable: { committedAt: '2026-11-24T00:00:00.000Z', decision: 'benefit', canary: { healthObservationWindow: 2, observations: 2, startupVerified: true } },
    requiredServices: [], serviceMembers: {}, requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include'],
    hostOnly: true, host: { dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0', verifiedAt: '2026-11-24T00:00:00.000Z' },
    revalidation: [], publishedAt: '2026-11-24T00:00:00.000Z',
  };
  return { paths, record };
}

test('per-profile supersession markers do not overwrite each other', () => {
  const both = pair({ oldMarker: { acp: marker(), web: marker({ recordId: NEW }) } });
  for (const profile of ['acp', 'web']) {
    const [old, replacement] = applySupersession(both, { profile });
    assert.equal(old.decision.status, SHARED_STATUS.DISABLED);
    assert.equal(replacement.decision.status, 'eligible');
  }
});

test('a chain resolves to the final eligible version, never two overlapping records', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const acp = marker();
  const web = marker({ recordId: THIRD, sourceSha256: 'f'.repeat(64) });
  const rows = [
    { record: { id: OLD, sourceSha256: 'a'.repeat(64), supersededBy: { acp } }, decision: { status: 'eligible' } },
    { record: { id: NEW, sourceSha256: 'b'.repeat(64), supersededBy: { acp: { ...acp, recordId: THIRD, sourceSha256: 'f'.repeat(64) } } }, decision: { status: 'eligible' } },
    { record: { id: THIRD, sourceSha256: 'f'.repeat(64) }, decision: { status: 'eligible' } },
  ];
  const result = applySupersession(rows, { profile: 'acp' });
  assert.equal(result[0].decision.status, SHARED_STATUS.DISABLED);
  assert.equal(result[0].decision.supersededBy, THIRD);
  assert.equal(result[1].decision.status, SHARED_STATUS.DISABLED);
  assert.equal(result[1].decision.supersededBy, THIRD);
  assert.equal(result[2].decision.status, 'eligible');
});

test('when the chain tail is ineligible the previous eligible version survives', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const rows = [
    { record: { id: OLD, sourceSha256: 'a'.repeat(64), supersededBy: { acp: marker() } }, decision: { status: 'eligible' } },
    { record: { id: NEW, sourceSha256: 'b'.repeat(64), supersededBy: { acp: marker({ recordId: THIRD, sourceSha256: 'f'.repeat(64) }) } }, decision: { status: 'eligible' } },
    { record: { id: THIRD, sourceSha256: 'f'.repeat(64) }, decision: { status: 'pending-revalidation' } },
  ];
  const result = applySupersession(rows, { profile: 'acp' });
  assert.equal(result[0].decision.status, SHARED_STATUS.DISABLED);
  assert.equal(result[0].decision.supersededBy, NEW);
  assert.equal(result[1].decision.status, 'eligible', 'B stays mounted; only C was removed');
  assert.equal(result[2].decision.status, 'pending-revalidation');
});

test('traversal crosses an ineligible intermediate to the still-eligible tail', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const rows = [
    { record: { id: OLD, sourceSha256: 'a'.repeat(64), supersededBy: { acp: marker() } }, decision: { status: 'eligible' } },
    { record: { id: NEW, sourceSha256: 'b'.repeat(64), supersededBy: { acp: marker({ recordId: THIRD, sourceSha256: 'f'.repeat(64) }) } }, decision: { status: SHARED_STATUS.DISABLED, reason: 'operator-disabled' } },
    { record: { id: THIRD, sourceSha256: 'f'.repeat(64) }, decision: { status: 'eligible' } },
  ];
  const result = applySupersession(rows, { profile: 'acp' });
  assert.equal(result[0].decision.status, SHARED_STATUS.DISABLED);
  assert.equal(result[0].decision.supersededBy, THIRD, 'A stays suppressed in favour of the tail');
  assert.equal(result[1].decision.status, SHARED_STATUS.DISABLED, 'B stays operator-disabled');
  assert.equal(result[2].decision.status, 'eligible');
});

test('a cycle suppresses nothing', () => {
  const rows = [
    { record: { id: OLD, sourceSha256: 'a'.repeat(64), supersededBy: { acp: marker() } }, decision: { status: 'eligible' } },
    { record: { id: NEW, sourceSha256: 'b'.repeat(64), supersededBy: { acp: marker({ recordId: OLD, sourceSha256: 'a'.repeat(64) }) } }, decision: { status: 'eligible' } },
  ];
  for (const row of applySupersession(rows, { profile: 'acp' })) {
    assert.equal(row.decision.status, 'eligible');
  }
});

test('an invalid intermediate version stops chain traversal', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const rows = [
    { record: { id: OLD, sourceSha256: 'a'.repeat(64), supersededBy: { acp: marker() } }, decision: { status: 'eligible' } },
    { record: { id: NEW, sourceSha256: 'b'.repeat(64), supersededBy: { acp: marker({ recordId: THIRD, sourceSha256: 'f'.repeat(64) }) } }, decision: { status: SHARED_STATUS.INVALID, reason: 'source-digest-mismatch' } },
    { record: { id: THIRD, sourceSha256: 'f'.repeat(64) }, decision: { status: 'eligible' } },
  ];
  const result = applySupersession(rows, { profile: 'acp' });
  assert.equal(result[0].decision.status, 'eligible', 'A is not suppressed through an invalid B');
  assert.equal(result[1].decision.status, SHARED_STATUS.INVALID);
  assert.equal(result[2].decision.status, 'eligible');
});

test('a cycle in one chain does not cancel an independent valid replacement', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const FOURTH = 'evolution-promoted-dddddddddddd';
  const rows = [
    { record: { id: OLD, sourceSha256: 'a'.repeat(64), supersededBy: { acp: marker() } }, decision: { status: 'eligible' } },
    { record: { id: NEW, sourceSha256: 'b'.repeat(64) }, decision: { status: 'eligible' } },
    { record: { id: THIRD, sourceSha256: 'c'.repeat(64), supersededBy: { acp: marker({ recordId: FOURTH, sourceSha256: 'd'.repeat(64) }) } }, decision: { status: 'eligible' } },
    { record: { id: FOURTH, sourceSha256: 'd'.repeat(64), supersededBy: { acp: marker({ recordId: THIRD, sourceSha256: 'c'.repeat(64) }) } }, decision: { status: 'eligible' } },
  ];
  const result = applySupersession(rows, { profile: 'acp' });
  assert.equal(result[0].decision.status, SHARED_STATUS.DISABLED, 'the valid chain still suppresses its old record');
  assert.equal(result[0].decision.supersededBy, NEW);
  assert.equal(result[1].decision.status, 'eligible');
  assert.equal(result[2].decision.status, 'eligible', 'a cycle member is never a fallback terminal');
  assert.equal(result[3].decision.status, 'eligible', 'the independent cycle suppresses nothing');
});

test('an ordinary republish keeps annotations added after the first publish', async (t) => {
  const { paths, record } = await recordFixture(t);
  await publishSharedRecord(paths, record);
  await publishSharedRecord(paths, { ...record, approvedProfiles: ['acp', 'web'], supersededBy: supersededBy() });
  const revalidation = { at: '2026-11-25T00:00:00.000Z', dsh: '0.2.3', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0', profiles: ['acp'], evidenceSha256: 'e'.repeat(64) };
  await publishSharedRecord(paths, { ...record, revalidation: [revalidation] });
  const index = await readSharedIndex(paths);
  assert.deepEqual(index.records[0].approvedProfiles, ['acp', 'web']);
  assert.equal(index.records[0].supersededBy.acp.recordId, NEW);
  assert.equal(index.records[0].revalidation.length, 1);
});

test('revoke disables the replacement before clearing the marker', async (t) => {
  const { paths, record } = await recordFixture(t);
  await publishSharedRecord(paths, { ...record, supersededBy: supersededBy() });
  const result = await revokeSharedSupersession(paths, { oldId: OLD, profile: 'acp', reason: 'revoke-supersede:abc123' });
  assert.equal(result.status, 'updated');
  const index = await readSharedIndex(paths);
  assert.equal(index.records[0].supersededBy, undefined);
  const disable = await readDisableState(paths);
  assert.ok(disable.entries.some((entry) => entry.pluginId === NEW && entry.profile === 'acp'));
});

test('revoking one of two records sharing a replacement keeps the replacement enabled', async (t) => {
  const FOURTH = 'evolution-promoted-cccccccccccc';
  const { paths, record: a } = await recordFixture(t, OLD);
  const { record: c } = await recordFixture(t, NEW, paths.dataRoot);
  const { record: b } = await recordFixture(t, FOURTH, paths.dataRoot);
  const sharedMarker = () => marker({ recordId: NEW, sourceSha256: c.sourceSha256 });
  await publishSharedRecord(paths, { ...a, supersededBy: { acp: sharedMarker() } });
  await publishSharedRecord(paths, c);
  await publishSharedRecord(paths, { ...b, supersededBy: { acp: sharedMarker() } });

  const result = await revokeSharedSupersession(paths, { oldId: OLD, profile: 'acp', reason: 'revoke-supersede:shared' });
  assert.equal(result.status, 'updated');
  const index = await readSharedIndex(paths);
  const byId = new Map(index.records.map((row) => [row.id, row]));
  assert.equal(byId.get(OLD).supersededBy, undefined, 'A marker is cleared');
  assert.equal(byId.get(FOURTH).supersededBy.acp.recordId, NEW, 'B marker still points at the shared replacement');
  const disable = await readDisableState(paths);
  assert.ok(!disable.entries.some((entry) => entry.pluginId === NEW && entry.profile === 'acp'), 'the shared replacement stays enabled');

  const eligible = (record) => ({ record, decision: { status: 'eligible' } });
  const [ra, rb, rc] = applySupersession([
    eligible(byId.get(OLD)), eligible(byId.get(FOURTH)), eligible(byId.get(NEW)),
  ], { profile: 'acp' });
  assert.equal(ra.decision.status, 'eligible', 'A regains eligibility');
  assert.equal(rb.decision.status, SHARED_STATUS.DISABLED, 'B still yields to C');
  assert.equal(rb.decision.supersededBy, NEW);
  assert.equal(rc.decision.status, 'eligible');
});

test('a non-tail supersession cannot be revoked out of order', async (t) => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const { paths, record } = await recordFixture(t);
  const second = await recordFixture(t, NEW, paths.dataRoot);
  await publishSharedRecord(paths, { ...record, supersededBy: { acp: marker({ recordId: NEW }) } });
  await publishSharedRecord(paths, {
    ...second.record,
    supersededBy: { acp: marker({ recordId: THIRD, sourceSha256: 'f'.repeat(64) }) },
  });
  const result = await revokeSharedSupersession(paths, { oldId: OLD, profile: 'acp', reason: 'revoke-supersede:abc' });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'revoke-chain-tail-first');
  const disable = await readDisableState(paths);
  assert.deepEqual(disable.entries, [], 'nothing was disabled on a refused revoke');
});

test('the index rejects a malformed supersession or approval annotation', async (t) => {
  const { paths, record } = await recordFixture(t);
  assert.equal(validateSharedRecord(record, paths).ok, true);
  for (const bad of [
    { supersededBy: { acp: { ...marker(), recordId: 'not-a-plugin-id' } } },
    { supersededBy: { acp: { ...marker(), sourceSha256: 'XYZ' } } },
    { supersededBy: { desktop: marker() } },
    { supersededBy: {} },
    { approvalExtensions: [{ kind: 'unknown', profile: 'acp', sourceSha256: 'a'.repeat(64), approvalSha256: 'b'.repeat(64), at: '2026-11-24T00:00:00.000Z' }] },
  ]) {
    const verdict = validateSharedRecord({ ...record, ...bad }, paths);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
  }
  const good = validateSharedRecord({ ...record, supersededBy: supersededBy() }, paths);
  assert.equal(good.ok, true, good.reason);
});

test('lock-internal annotations compose instead of overwriting earlier approvals', async (t) => {
  const { paths, record } = await recordFixture(t);
  await publishSharedRecord(paths, record);
  const first = await annotateSharedRecord(paths, record.id, (current) => ({
    ...current, approvedProfiles: ['acp', 'web'],
  }));
  assert.equal(first.status, 'updated');
  const second = await annotateSharedRecord(paths, record.id, (current) => ({
    ...current, supersededBy: supersededBy(),
  }));
  assert.equal(second.status, 'updated');
  const index = await readSharedIndex(paths);
  assert.deepEqual(index.records[0].approvedProfiles, ['acp', 'web'], 'the earlier approval survives');
  assert.equal(index.records[0].supersededBy.acp.recordId, NEW);
});

test('publishSharedRecord preserves publication identity when a supersession is added', async (t) => {
  const { paths, record } = await recordFixture(t);
  assert.equal((await publishSharedRecord(paths, record)).status, 'published');
  const result = await publishSharedRecord(paths, { ...record, supersededBy: supersededBy() });
  assert.equal(result.status, 'updated');
  const index = await readSharedIndex(paths);
  assert.equal(index.records[0].publishedAt, record.publishedAt);
  assert.equal(index.records[0].host.dsh, record.host.dsh);
  assert.equal(index.records[0].sourceSha256, record.sourceSha256);
  assert.equal(index.records[0].supersededBy.acp.recordId, NEW);
});
