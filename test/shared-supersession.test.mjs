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
  applySupersession,
  publishSharedRecord,
  readSharedIndex,
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
    summary: 'owner approved replacement',
    profiles: ['acp'],
    ...overrides,
  };
}

function pair({ replacementStatus = 'eligible', replacementSource = 'b'.repeat(64), replacementSuperseded = false, oldMarker = marker() } = {}) {
  const old = { id: OLD, sourceSha256: 'a'.repeat(64), ...(oldMarker ? { supersededBy: oldMarker } : {}) };
  const replacement = {
    id: NEW,
    sourceSha256: replacementSource,
    ...(replacementSuperseded ? { supersededBy: marker({ recordId: OLD }) } : {}),
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

async function recordFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-supersession-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, 'promoted');
  const pluginName = `dsh-${OLD}`;
  const pluginDir = path.join(pluginRoot, pluginName, 'lib');
  await fs.mkdir(pluginDir, { recursive: true });
  const modulePath = path.join(pluginDir, 'index.js');
  const source = 'export const name = "old";\nexport const inject = [];\nexport function apply() {}\n';
  await fs.writeFile(modulePath, source);
  await fs.writeFile(path.join(pluginRoot, pluginName, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  const paths = { dataRoot: root, pluginRoot };
  const record = {
    id: OLD, schemaVersion: 1, experimentId: 'exp-old', pluginName, moduleUrl: pathToFileURL(modulePath).href,
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

test('the index rejects a malformed supersession or approval annotation', async (t) => {
  const { paths, record } = await recordFixture(t);
  assert.equal(validateSharedRecord(record, paths).ok, true);
  for (const bad of [
    { supersededBy: { ...marker(), recordId: 'not-a-plugin-id' } },
    { supersededBy: { ...marker(), sourceSha256: 'XYZ' } },
    { supersededBy: { ...marker(), profiles: ['desktop'] } },
    { supersededBy: { ...marker(), summary: 'x'.repeat(500) } },
    { approvalExtensions: [{ kind: 'unknown', profile: 'acp', sourceSha256: 'a'.repeat(64), approvalSha256: 'b'.repeat(64), at: '2026-11-24T00:00:00.000Z', summary: '' }] },
  ]) {
    const verdict = validateSharedRecord({ ...record, ...bad }, paths);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
  }
  const good = validateSharedRecord({ ...record, supersededBy: marker() }, paths);
  assert.equal(good.ok, true, good.reason);
});

test('publishSharedRecord preserves publication identity when a supersession is added', async (t) => {
  const { paths, record } = await recordFixture(t);
  assert.equal((await publishSharedRecord(paths, record)).status, 'published');
  const result = await publishSharedRecord(paths, { ...record, supersededBy: marker() });
  assert.equal(result.status, 'updated');
  const index = await readSharedIndex(paths);
  assert.equal(index.records[0].publishedAt, record.publishedAt);
  assert.equal(index.records[0].host.dsh, record.host.dsh);
  assert.equal(index.records[0].sourceSha256, record.sourceSha256);
  assert.equal(index.records[0].supersededBy.recordId, NEW);
});
