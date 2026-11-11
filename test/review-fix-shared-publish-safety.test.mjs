// Regression for the sharing-safety findings of the reliability review round.
//
// 1. Operator revocation must fail closed. `readDisableState()` reports an
//    unreadable or malformed `disabled.json` as `invalid`/`unreadable` with an
//    empty entry list; a consumer that ignored that status would mount a plugin
//    the operator may have disabled. Every record is now refused while the
//    revocation table is unknown, and the doctor degrades instead of reporting
//    a healthy publish set.
// 2. Startup reconciliation must reach a crash window on a store with more than
//    `maxRecords` experiments. It used to sort sidecar names ascending and read
//    only the first 200, so the newest stable commit (the one whose index write
//    was lost) was never read; sidecars whose experiment already has a published
//    record are now skipped without a read and the newest candidates are read
//    first.
//
// Every fixture lives under a fresh os.tmpdir() directory; nothing reads a real
// DSH home or a real promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildSharedRecord,
  evaluateSharedRecord,
  publishSharedRecord,
  readSharedIndex,
  reconcileSharedIndex,
  scanStableShareCandidates,
  setDisabledForProfile,
  sharingPaths,
  SHARED_STATUS,
} from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const HOST = { profile: 'desktop', dsh: '0.2.4', cordis: '4.1.0', include: '1.1.0', node: process.version, capturedAt: '2026-01-01T00:00:00.000Z' };
const CAPABILITIES = { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true };

async function scratch(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `evo-shared-safety-${name}-`));
}

async function fixture(t, { id = 'exp-shared-safety-1', pluginName = 'dsh-evolution-promoted-abcdefabcdef' } = {}) {
  const root = await scratch('root');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {
    dataRoot: root,
    presetDir: root,
    pluginRoot: path.join(root, 'promoted'),
    archiveDir: path.join(root, 'archive'),
  };
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const source = `export const name = ${JSON.stringify(pluginName)};\nexport const inject = ["tools"];\nexport function apply() {}\n`;
  await fs.writeFile(path.join(pluginDir, 'lib', 'index.js'), source);
  const manifest = `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`;
  await fs.writeFile(path.join(pluginDir, 'package.json'), manifest);
  await fs.mkdir(paths.archiveDir, { recursive: true });
  const durable = {
    pluginName,
    pluginPath: pluginDir,
    moduleUrl: pathToFileURL(path.join(pluginDir, 'lib', 'index.js')).href,
    rowId: `evolution-promoted-${pluginName.slice('dsh-evolution-promoted-'.length)}`,
  };
  const experiment = {
    id,
    state: 'stable',
    stableCommittedAt: '2026-01-02T00:00:00.000Z',
    shareTargets: ['acp', 'web'],
    canary: {
      healthObservationWindow: 2,
      startupVerified: true,
      observations: [{ barrierId: 'startup:desktop' }, { barrierId: 'post:desktop' }],
    },
    decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
    durable,
  };
  return { root, paths, pluginDir, source, manifest, durable, experiment };
}

async function buildRecord(env, overrides = {}) {
  return buildSharedRecord({
    paths: env.paths,
    experiment: overrides.experiment ?? env.experiment,
    durable: overrides.durable ?? env.durable,
    approvedProfiles: overrides.approvedProfiles ?? env.experiment.shareTargets,
    host: overrides.host ?? HOST,
    capabilities: overrides.capabilities ?? CAPABILITIES,
    source: { stableCommittedAt: overrides.stableCommittedAt ?? env.experiment.stableCommittedAt },
  });
}

function sidecar(env) {
  return {
    stableCommittedAt: env.experiment.stableCommittedAt,
    shareTargets: ['acp'],
    durable: env.durable,
    canary: env.experiment.canary,
    decision: { kind: 'benefit' },
    publication: {
      sourceSha256: HEX(env.source),
      manifestSha256: HEX(env.manifest),
      verifiedAt: '2026-01-02T00:00:00.000Z',
      host: HOST,
    },
  };
}

async function writeSidecar(env, experimentId, value) {
  await fs.writeFile(path.join(env.paths.archiveDir, `${experimentId}.evidence.json`), JSON.stringify(value));
}

test('a consumer refuses every record while the revocation table is unreadable or malformed', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  const base = {
    paths: env.paths,
    record,
    profile: 'acp',
    host: { ...HOST, profile: 'acp' },
    capabilities: CAPABILITIES,
    services: { has: () => true, memberPresent: () => true },
    mountedModuleUrls: [],
    previousState: null,
  };
  assert.equal((await evaluateSharedRecord({ ...base, disableState: { status: 'ok', entries: [] } })).status, 'eligible');
  assert.equal((await evaluateSharedRecord({ ...base, disableState: { status: 'absent', entries: [] } })).status, 'eligible');
  const malformed = await evaluateSharedRecord({ ...base, disableState: { status: 'invalid', entries: [] } });
  assert.equal(malformed.status, SHARED_STATUS.INVALID);
  assert.equal(malformed.reason, 'disable-state-invalid');
  const unreadable = await evaluateSharedRecord({ ...base, disableState: { status: 'unreadable', entries: [], error: {} } });
  assert.equal(unreadable.status, SHARED_STATUS.INVALID);
  assert.equal(unreadable.reason, 'disable-state-unreadable');
});

test('reconciliation reaches a recent crash window beyond the read budget', async (t) => {
  const env = await fixture(t, { id: 'exp-zzzz-crash-window' });
  await writeSidecar(env, 'exp-zzzz-crash-window', sidecar(env));
  // 205 older experiment sidecars (Desktop-only, so none is publishable) sort
  // before the crash-window candidate. The old ascending read consumed the
  // whole 200-record budget on these names and never opened the candidate.
  for (let index = 0; index < 205; index += 1) {
    const id = `exp-old-${String(index).padStart(4, '0')}`;
    await writeSidecar(env, id, { stableCommittedAt: env.experiment.stableCommittedAt, shareTargets: [] });
  }
  const candidates = await scanStableShareCandidates(env.paths, { maxRecords: 200 });
  assert.deepEqual(candidates.map((row) => row.experimentId), ['exp-zzzz-crash-window']);

  const result = await reconcileSharedIndex({ paths: env.paths, host: HOST, capabilities: CAPABILITIES, maxRecords: 200 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.published.map((row) => row.id), [env.durable.rowId]);
  const index = await readSharedIndex(env.paths);
  assert.deepEqual(index.records.map((row) => row.id), [env.durable.rowId]);

  // A published sidecar is not read again: a second pass has nothing to do.
  const again = await reconcileSharedIndex({ paths: env.paths, host: HOST, capabilities: CAPABILITIES, maxRecords: 200 });
  assert.deepEqual(again.published, []);
  assert.equal(again.unchanged, 1);
  // Even a damaged sidecar of an already-published experiment cannot make the
  // pass fail or republish: it is skipped by experiment id without being read.
  await fs.writeFile(path.join(env.paths.archiveDir, 'exp-zzzz-crash-window.evidence.json'), '{not json');
  const third = await reconcileSharedIndex({ paths: env.paths, host: HOST, capabilities: CAPABILITIES, maxRecords: 200 });
  assert.equal(third.status, 'ok');
  assert.deepEqual(third.published, []);
  assert.deepEqual(third.skipped, []);
});

test('revocation state written by the CLI still disables one profile', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  await publishSharedRecord(env.paths, record);
  const { readDisableState } = await import('../lib/promoted-sharing.js');
  await setDisabledForProfile(env.paths, { pluginId: record.id, profile: 'acp', disabled: true });
  assert.equal((await readDisableState(env.paths)).status, 'ok');
  const decision = await evaluateSharedRecord({
    paths: env.paths,
    record,
    profile: 'acp',
    host: { ...HOST, profile: 'acp' },
    capabilities: CAPABILITIES,
    services: { has: () => true, memberPresent: () => true },
    mountedModuleUrls: [],
    disableState: await readDisableState(env.paths),
    previousState: null,
  });
  assert.equal(decision.status, SHARED_STATUS.DISABLED);
  assert.equal(decision.reason, 'operator-disabled');
});

test('a write to a corrupt revocation table is refused and leaves it untouched', async (t) => {
  const env = await fixture(t);
  const record = await buildRecord(env);
  await publishSharedRecord(env.paths, record);
  const disablePath = sharingPaths(env.paths).disablePath;
  const corrupt = '{not json';
  await fs.writeFile(disablePath, corrupt);
  await assert.rejects(
    setDisabledForProfile(env.paths, { pluginId: record.id, profile: 'acp', disabled: true }),
    /revocation table is invalid/,
  );
  assert.equal(await fs.readFile(disablePath, 'utf8'), corrupt, 'the unknown file is preserved, never rewritten from empty entries');
});

test('reconciliation keeps the sidecar read budget bounded', async (t) => {
  const env = await fixture(t, { id: 'exp-zzzz-budget' });
  await writeSidecar(env, 'exp-zzzz-budget', sidecar(env));
  // Older names sort before the candidate; none of them is publishable.
  for (let index = 0; index < 20; index += 1) {
    await writeSidecar(env, `exp-old-${String(index).padStart(4, '0')}`, {
      stableCommittedAt: env.experiment.stableCommittedAt,
      shareTargets: [],
    });
  }
  let reads = 0;
  const originalRead = fs.readFile;
  fs.readFile = async function (file, ...rest) {
    if (String(file).endsWith('.evidence.json')) reads += 1;
    return originalRead.call(this, file, ...rest);
  };
  t.after(() => { fs.readFile = originalRead; });
  const candidates = await scanStableShareCandidates(env.paths, { maxRecords: 1 });
  assert.deepEqual(candidates.map((row) => row.experimentId), ['exp-zzzz-budget']);
  assert.equal(reads, 1, 'maxRecords still bounds how many sidecars are read');
  // Newest-first is bounded, not unbounded: newer non-candidates consume the
  // budget, so an older candidate is not read. The previous unbounded scan
  // would have returned it (and read every sidecar).
  reads = 0;
  const budgetEnv = await fixture(t, { id: 'exp-zzzz-budget-two' });
  await writeSidecar(budgetEnv, 'exp-zzzz-budget-two', sidecar(budgetEnv));
  for (let index = 0; index < 4; index += 1) {
    await writeSidecar(budgetEnv, `exp-zzzz-newer-${String(index).padStart(4, '0')}`, {
      stableCommittedAt: budgetEnv.experiment.stableCommittedAt,
      shareTargets: [],
    });
  }
  const bounded = await scanStableShareCandidates(budgetEnv.paths, { maxRecords: 2 });
  assert.equal(reads, 2, 'two reads, both spent on the newest non-candidates');
  assert.deepEqual(bounded, [], 'the older candidate is outside the read budget');
});
