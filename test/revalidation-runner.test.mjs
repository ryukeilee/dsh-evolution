import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const runner = await import(pathToFileURL(path.join(ROOT, 'scripts/acceptance/run-revalidation.mjs')).href);

const TARGET_A = 'evolution-promoted-aaaaaaaaaaaa';
const TARGET_B = 'evolution-promoted-bbbbbbbbbbbb';
const CURRENT_HOST = { dsh: '0.2.2-rc.3', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0' };
const { applySupersession, validateSharedRecord } = await import(pathToFileURL(path.join(ROOT, 'lib', 'promoted-sharing.js')).href);

function supersededIndex() {
  const previousHost = { dsh: '0.2.2-rc.2', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0' };
  return {
    schemaVersion: 1,
    plugins: [
      {
        id: TARGET_A,
        pluginName: 'dsh-a',
        approvedProfiles: ['acp', 'web'],
        host: { ...previousHost },
        sourceSha256: 'a'.repeat(64),
        supersededBy: { acp: { recordId: TARGET_B, sourceSha256: 'b'.repeat(64) } },
      },
      {
        id: TARGET_B,
        pluginName: 'dsh-b',
        approvedProfiles: ['acp', 'web'],
        host: { ...previousHost },
        sourceSha256: 'b'.repeat(64),
      },
    ],
  };
}

function eligibilityDecisions(records, profile) {
  return records.map((record) => ({
    record,
    decision: record.approvedProfiles.includes(profile)
      ? { status: 'eligible' }
      : { status: 'disabled', reason: 'operator-disabled' },
  }));
}

/** A structurally valid published record, so integrity is about the overrides. */
function validRecord(id, overrides = {}) {
  const pluginName = `dsh-${id}`;
  return {
    id,
    schemaVersion: 1,
    experimentId: `exp-${id}`,
    pluginName,
    moduleUrl: pathToFileURL(path.join('/clone', 'promoted', pluginName, 'lib', 'index.js')).href,
    entry: 'lib/index.js',
    sourceSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    publisherProfile: 'desktop',
    approvedProfiles: ['acp'],
    stable: {
      committedAt: '2026-01-01T00:00:00.000Z',
      decision: 'benefit',
      canary: { healthObservationWindow: 2, observations: 2, startupVerified: true },
    },
    requiredServices: [],
    serviceMembers: {},
    requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include'],
    hostOnly: true,
    host: { ...CURRENT_HOST },
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const validMarker = (id, sourceSha256) => ({
  recordId: id,
  sourceSha256,
  approvalSha256: 'c'.repeat(64),
  evidenceSha256: 'd'.repeat(64),
  at: '2026-01-02T00:00:00.000Z',
});

test('revalidation runner: a partially revoked record still has its other profile as a target', () => {
  const record = { id: TARGET_A, approvedProfiles: ['acp', 'web'] };
  const disable = { entries: [{ pluginId: TARGET_A, profile: 'web', reason: 'operator test' }] };
  assert.equal(runner.profileIsRevalidationTarget(record, 'acp', disable), true);
  assert.equal(runner.profileIsRevalidationTarget(record, 'web', disable), false,
    'a revoked profile must never be expected active in verification or post-adoption checks');
  assert.equal(runner.profileIsRevalidationTarget({ id: TARGET_B, approvedProfiles: ['acp'] }, 'web', disable), false);
  // A fully revoked record is excluded earlier by the target selector.
  const allRevoked = { entries: [
    { pluginId: TARGET_A, profile: 'acp' }, { pluginId: TARGET_A, profile: 'web' },
  ] };
  assert.equal(runner.profileIsRevalidationTarget(record, 'acp', allRevoked), false);
  assert.equal(runner.profileIsRevalidationTarget(record, 'web', allRevoked), false);
});

test('revalidation runner: isolating a superseded record leaves only that record eligible', () => {
  const index = supersededIndex();
  const dataRoot = '/clone/storages/evolution';
  const isolated = runner.isolationIndex(index, {
    dataRoot,
    host: CURRENT_HOST,
    profile: 'acp',
    recordId: TARGET_A,
    now: '2026-01-02T00:00:00.000Z',
  });
  const [a, b] = isolated.plugins;
  assert.deepEqual(a.approvedProfiles, ['acp', 'web'], 'the tested record keeps the tested profile');
  assert.deepEqual(b.approvedProfiles, ['web'], 'every other record loses only the tested profile');
  assert.equal(a.host.dsh, '0.2.2-rc.3');
  assert.equal(a.host.verifiedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(b.host.dsh, '0.2.2-rc.2', 'a non-tested record never gets a rewritten host');
  assert.equal(b.host.verifiedAt, undefined);
  assert.deepEqual(a.supersededBy, { acp: { recordId: TARGET_B, sourceSha256: 'b'.repeat(64) } }, 'supersession markers are retained');
  assert.equal(a.moduleUrl, pathToFileURL(path.join(dataRoot, 'promoted', 'dsh-a', 'lib', 'index.js')).href);
  assert.equal(b.moduleUrl, pathToFileURL(path.join(dataRoot, 'promoted', 'dsh-b', 'lib', 'index.js')).href);
  const decisions = applySupersession(eligibilityDecisions(isolated.plugins, 'acp'), { profile: 'acp' });
  assert.deepEqual(decisions.filter(({ decision }) => decision.status === 'eligible').map(({ record }) => record.id), [TARGET_A]);
  assert.equal(decisions.find(({ record }) => record.id === TARGET_B).decision.reason, 'operator-disabled');
  // The source index is a deep-copy source: it is never rewritten in place.
  assert.deepEqual(index.plugins[0].approvedProfiles, ['acp', 'web']);
  assert.equal(index.plugins[0].host.dsh, '0.2.2-rc.2');
  assert.equal(index.plugins[0].moduleUrl, undefined);
});

test('revalidation runner: isolating a non-target record leaves its own host and profile eligibility', () => {
  const index = supersededIndex();
  const isolated = runner.isolationIndex(index, {
    dataRoot: '/clone/storages/evolution',
    host: CURRENT_HOST,
    profile: 'acp',
    recordId: TARGET_B,
    now: '2026-01-02T00:00:00.000Z',
  });
  const [a, b] = isolated.plugins;
  assert.deepEqual(a.approvedProfiles, ['web'], 'the replacement must not answer for the tested record');
  assert.deepEqual(b.approvedProfiles, ['acp', 'web']);
  assert.equal(a.host.dsh, '0.2.2-rc.2');
  assert.equal(b.host.dsh, '0.2.2-rc.3');
  assert.ok(a.supersededBy.acp, 'supersession is never stripped from the clone');
  const decisions = applySupersession(eligibilityDecisions(isolated.plugins, 'acp'), { profile: 'acp' });
  assert.deepEqual(decisions.filter(({ decision }) => decision.status === 'eligible').map(({ record }) => record.id), [TARGET_B]);
});

test('revalidation runner: the clone keeps supersession markers', () => {
  const index = supersededIndex();
  const clone = runner.rewriteIndexForVerification(index, { dataRoot: os.tmpdir() });
  assert.deepEqual(clone.plugins[0].supersededBy, { acp: { recordId: TARGET_B, sourceSha256: 'b'.repeat(64) } },
    'an overlapping replacement must never be removed from the attestation clone');
  assert.equal(clone.plugins[1].host.dsh, '0.2.2-rc.2');
});

test('revalidation runner: operator-disabled links traverse to the terminal version', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const records = [
    validRecord(TARGET_A, { supersededBy: { acp: validMarker(TARGET_B, 'b'.repeat(64)) } }),
    validRecord(TARGET_B, {
      sourceSha256: 'b'.repeat(64),
      supersededBy: { acp: validMarker(THIRD, 'c'.repeat(64)) },
    }),
    validRecord(THIRD, { sourceSha256: 'c'.repeat(64) }),
  ];
  // B is operator-disabled in acp, so it has no isolated boot; A and C did boot.
  const bootStatuses = new Map([
    [TARGET_A, { status: 'active' }],
    [THIRD, { status: 'active' }],
  ]);
  const disable = { entries: [{ pluginId: TARGET_B, profile: 'acp' }] };
  const result = runner.expectedAfterAdoption(records, 'acp', bootStatuses, disable, '/clone/promoted');
  assert.deepEqual(result.get(TARGET_B), { status: 'disabled', reason: 'operator-disabled' },
    'an operator-disabled link is a real skip, not a missing/invalid record');
  assert.deepEqual(result.get(TARGET_A), { status: 'disabled', reason: 'superseded-by', supersededBy: THIRD },
    'the chain must still traverse B to C instead of inventing an active A');
  assert.equal(result.get(THIRD).status, 'eligible');
});

test('revalidation runner: unapproved and fully revoked records are non-integrity skips', () => {
  const REVOKED = 'evolution-promoted-dddddddddddd';
  const records = [
    validRecord(TARGET_A, { approvedProfiles: ['web'] }),
    validRecord(REVOKED, { approvedProfiles: ['acp', 'web'], sourceSha256: 'd'.repeat(64) }),
  ];
  const disable = { entries: [
    { pluginId: REVOKED, profile: 'acp' },
    { pluginId: REVOKED, profile: 'web' },
  ] };
  const result = runner.expectedAfterAdoption(records, 'acp', new Map(), disable, '/clone/promoted');
  assert.deepEqual(result.get(TARGET_A), { status: 'skipped-unapproved', reason: 'profile-not-approved' });
  assert.deepEqual(result.get(REVOKED), { status: 'disabled', reason: 'operator-disabled' },
    'a fully revoked record is disabled in this profile, not skipped-invalid');
});

test('revalidation runner: an ineligible tail restores its predecessor after adoption', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const records = [
    { id: TARGET_A, approvedProfiles: ['acp'], supersededBy: { acp: { recordId: TARGET_B, sourceSha256: 'b'.repeat(64) } } },
    { id: TARGET_B, approvedProfiles: ['acp'], sourceSha256: 'b'.repeat(64), supersededBy: { acp: { recordId: THIRD, sourceSha256: 'f'.repeat(64) } } },
    { id: THIRD, approvedProfiles: ['acp'], sourceSha256: 'f'.repeat(64) },
  ];
  const evidence = new Map([
    [TARGET_A, { status: 'active' }],
    [TARGET_B, { status: 'active' }],
    [THIRD, { status: 'skipped-incompatible', reason: 'missing-service' }],
  ]);
  const result = runner.expectedAfterAdoption(records, 'acp', evidence, undefined, '/clone/promoted');
  assert.equal(result.get(TARGET_A).status, 'disabled');
  assert.equal(result.get(TARGET_A).reason, 'superseded-by');
  assert.equal(result.get(TARGET_A).supersededBy, TARGET_B);
  assert.equal(result.get(TARGET_B).status, 'eligible', 'B is the restored terminal for A');
  assert.equal(result.get(THIRD).status, 'skipped-incompatible');
});

test('revalidation runner: a revoked but structurally invalid link stops the chain', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  // B is revoked in acp AND structurally invalid (hostOnly=false). Production
  // drops it in readSharedIndex before any chain decision, so the runner must
  // predict it as skipped-invalid, not as a traversable operator-disabled hop.
  const a = validRecord(TARGET_A, {
    supersededBy: { acp: validMarker(TARGET_B, 'b'.repeat(64)) },
  });
  const b = validRecord(TARGET_B, { hostOnly: false });
  const c = validRecord(THIRD);
  const records = [a, b, c];
  const disable = { entries: [{ pluginId: TARGET_B, profile: 'acp', reason: 'operator' }] };
  const bootStatuses = new Map([
    [TARGET_A, { status: 'active' }],
    [THIRD, { status: 'active' }],
  ]);
  const result = runner.expectedAfterAdoption(records, 'acp', bootStatuses, disable, '/clone/promoted');
  assert.deepEqual(result.get(TARGET_B), { status: 'skipped-invalid', reason: 'record-host-only' },
    'structure is checked before revocation, exactly like the production consumer');
  assert.equal(result.get(TARGET_A).status, 'eligible',
    'an invalid middle link must not suppress its still-active predecessor (eligible -> active boot expectation)');
});

test('revalidation runner: consumer state snapshots restore the exact source bytes per boot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-consumer-state-'));
  try {
    const clone = path.join(root, 'clone');
    const stateDir = path.join(clone, 'storages', 'evolution', 'shared-plugins', 'consumers');
    fs.mkdirSync(stateDir, { recursive: true });
    const acpFile = path.join(stateDir, 'acp.json');
    const webFile = path.join(stateDir, 'web.json');
    const acpBytes = `${JSON.stringify({
      schemaVersion: 1,
      plugins: [{ id: TARGET_A, status: 'failed', reason: 'include-unavailable' }],
    }, null, 2)}\n`;
    const webBytes = `${JSON.stringify({
      schemaVersion: 1,
      plugins: [{ id: TARGET_B, status: 'active', reason: null }],
    }, null, 2)}\n`;
    fs.writeFileSync(acpFile, acpBytes);
    fs.writeFileSync(webFile, webBytes);

    const snapshot = runner.snapshotConsumerStates(clone, ['acp', 'web']);
    // A boot between the snapshot and the next one overwrites the real receipt.
    fs.writeFileSync(acpFile, `${JSON.stringify({
      schemaVersion: 1,
      plugins: [{ id: TARGET_A, status: 'skipped-unapproved', reason: 'profile-not-approved' }],
    }, null, 2)}\n`);
    runner.restoreConsumerStates(snapshot, clone);
    assert.equal(fs.readFileSync(acpFile, 'utf8'), acpBytes);
    assert.equal(fs.readFileSync(webFile, 'utf8'), webBytes);
    assert.equal(JSON.parse(fs.readFileSync(acpFile, 'utf8')).plugins[0].reason, 'include-unavailable');

    // Only one profile present: the other is a no-op, including a missing file.
    fs.rmSync(webFile);
    const partial = runner.snapshotConsumerStates(clone, ['acp', 'web']);
    fs.writeFileSync(acpFile, '{}\n');
    runner.restoreConsumerStates(partial, clone);
    assert.equal(fs.readFileSync(acpFile, 'utf8'), acpBytes);
    assert.equal(fs.existsSync(webFile), false);

    // No state files at all: both snapshot and restore are safe no-ops.
    fs.rmSync(acpFile);
    const empty = runner.snapshotConsumerStates(clone, ['acp', 'web']);
    runner.restoreConsumerStates(empty, clone);
    assert.equal(fs.existsSync(acpFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revalidation runner: restore replaces a consumer symlink instead of writing its target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-symlink-'));
  try {
    const source = path.join(root, 'source');
    const clone = path.join(root, 'clone');
    const sourceState = path.join(source, 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json');
    const cloneDir = path.join(clone, 'storages', 'evolution', 'shared-plugins', 'consumers');
    fs.mkdirSync(path.dirname(sourceState), { recursive: true });
    fs.writeFileSync(sourceState, 'source');
    fs.mkdirSync(cloneDir, { recursive: true });
    fs.symlinkSync(sourceState, path.join(cloneDir, 'acp.json'));

    const snapshot = runner.snapshotConsumerStates(clone, ['acp']);
    assert.equal(fs.readFileSync(path.join(cloneDir, 'acp.json'), 'utf8'), 'source');
    // A boot between the snapshot and the restore rewrites the source via the link.
    fs.writeFileSync(sourceState, 'changed');

    runner.restoreConsumerStates(snapshot, clone);
    assert.equal(fs.readFileSync(sourceState, 'utf8'), 'changed', 'the source home must never be written');
    const restored = path.join(cloneDir, 'acp.json');
    assert.equal(fs.lstatSync(restored).isSymbolicLink(), false, 'restore replaces the link itself');
    assert.equal(fs.readFileSync(restored, 'utf8'), 'source');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revalidation runner: restore refuses a consumer state directory outside the clone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-dirlink-'));
  try {
    const source = path.join(root, 'source');
    const clone = path.join(root, 'clone');
    const outsideDir = path.join(source, 'storages', 'evolution', 'shared-plugins', 'consumers');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'acp.json'), 'source');
    const cloneBase = path.join(clone, 'storages', 'evolution', 'shared-plugins');
    fs.mkdirSync(cloneBase, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(cloneBase, 'consumers'));

    const snapshot = runner.snapshotConsumerStates(clone, ['acp']);
    assert.equal(snapshot.get(path.join(cloneBase, 'consumers', 'acp.json')).toString(), 'source');
    fs.writeFileSync(path.join(outsideDir, 'acp.json'), 'changed');
    assert.throws(() => runner.restoreConsumerStates(snapshot, clone), /outside the clone/);
    assert.equal(fs.readFileSync(path.join(outsideDir, 'acp.json'), 'utf8'), 'changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revalidation runner: restore refuses a parent symlink outside the clone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-parentlink-'));
  try {
    const source = path.join(root, 'source');
    const clone = path.join(root, 'clone');
    const outsideBase = path.join(source, 'storages', 'evolution', 'shared-plugins');
    const outsideDir = path.join(outsideBase, 'consumers');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'acp.json'), 'source');
    const cloneEvolution = path.join(clone, 'storages', 'evolution');
    fs.mkdirSync(cloneEvolution, { recursive: true });
    fs.symlinkSync(outsideBase, path.join(cloneEvolution, 'shared-plugins'));

    const snapshot = runner.snapshotConsumerStates(clone, ['acp']);
    fs.writeFileSync(path.join(outsideDir, 'acp.json'), 'changed');
    assert.throws(() => runner.restoreConsumerStates(snapshot, clone), /outside the clone/);
    assert.equal(fs.readFileSync(path.join(outsideDir, 'acp.json'), 'utf8'), 'changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revalidation runner: a state file absent at snapshot time is removed on restore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-absent-'));
  try {
    const clone = path.join(root, 'clone');
    const stateDir = path.join(clone, 'storages', 'evolution', 'shared-plugins', 'consumers');
    fs.mkdirSync(stateDir, { recursive: true });
    const acpFile = path.join(stateDir, 'acp.json');
    assert.equal(fs.existsSync(acpFile), false, 'the source home has no consumer state file');

    const snapshot = runner.snapshotConsumerStates(clone, ['acp', 'web']);
    assert.equal(snapshot.get(acpFile), null, 'an absent file must be recorded so a later boot can be undone');
    // A boot creates a fresh state file that the next restore must not inherit.
    fs.writeFileSync(acpFile, '{"plugins":[{"status":"active"}]}\n');
    runner.restoreConsumerStates(snapshot, clone);
    assert.equal(fs.existsSync(acpFile), false, 'the boot-created file must be removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revalidation runner: removing a boot-created link never follows it to the source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-absent-link-'));
  try {
    const source = path.join(root, 'source');
    const clone = path.join(root, 'clone');
    const sourceFile = path.join(source, 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'source');
    const cloneDir = path.join(clone, 'storages', 'evolution', 'shared-plugins', 'consumers');
    fs.mkdirSync(cloneDir, { recursive: true });

    const snapshot = runner.snapshotConsumerStates(clone, ['acp']);
    fs.symlinkSync(sourceFile, path.join(cloneDir, 'acp.json'));
    runner.restoreConsumerStates(snapshot, clone);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'source', 'the source home must stay byte-identical');
    assert.equal(fs.existsSync(path.join(cloneDir, 'acp.json')), false, 'only the link itself is removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revalidation runner: parses its operator flags', () => {
  const options = runner.parseArgs(['--home', '/tmp/home', '--apply', '--json', '--timeout-ms', '9000']);
  assert.equal(options.home, path.resolve('/tmp/home'));
  assert.equal(options.apply, true);
  assert.equal(options.json, true);
  assert.equal(options.timeoutMs, 9000);
  assert.throws(() => runner.parseArgs(['--home']), /requires a value/);
  assert.throws(() => runner.parseArgs(['--nope']), /unknown argument/);
});

test('revalidation runner: the clone index moves module URLs and only target hosts', () => {
  const host = { dsh: '0.2.2-rc.3', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0' };
  const index = {
    schemaVersion: 1,
    kind: 'dsh-evolution-shared-plugins',
    updatedAt: '2026-01-01T00:00:00.000Z',
    plugins: [
      { id: TARGET_A, pluginName: 'p-a', host: { dsh: '0.2.2-rc.2', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0' }, moduleUrl: 'file:///real/a.js' },
      { id: TARGET_B, pluginName: 'p-b', host: { dsh: '0.2.2-rc.2', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0' }, moduleUrl: 'file:///real/b.js' },
    ],
  };
  const dataRoot = '/clone/storages/evolution';
  const rewritten = runner.rewriteIndexForVerification(index, {
    dataRoot,
    host,
    targets: [TARGET_A],
    now: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(rewritten.plugins[0].moduleUrl, pathToFileURL(path.join(dataRoot, 'promoted', 'p-a', 'lib', 'index.js')).href);
  assert.equal(rewritten.plugins[1].moduleUrl, pathToFileURL(path.join(dataRoot, 'promoted', 'p-b', 'lib', 'index.js')).href);
  assert.equal(rewritten.plugins[0].host.dsh, '0.2.2-rc.3');
  assert.equal(rewritten.plugins[0].host.verifiedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(rewritten.plugins[1].host.dsh, '0.2.2-rc.2');
  assert.equal(rewritten.updatedAt, '2026-01-02T00:00:00.000Z');
  // The clone is a deep copy: the index read from the source home is untouched.
  assert.equal(index.plugins[0].moduleUrl, 'file:///real/a.js');
  assert.equal(index.plugins[0].host.dsh, '0.2.2-rc.2');
  // A record whose module URL is already inside the data root stays correct.
  const again = runner.rewriteIndexForVerification(rewritten, { dataRoot, host: null, targets: [] });
  assert.equal(again.plugins[0].moduleUrl, rewritten.plugins[0].moduleUrl);
  assert.equal(again.plugins[0].host.dsh, '0.2.2-rc.3');
});

test('revalidation runner: plans expand $WORK and reject a tool-less entry', () => {
  const plans = {
    plans: {
      [TARGET_A]: {
        tool: 'readonly_git_file',
        arguments: { workdir: '$WORK/git-fixture', nested: { file: '$WORK/p' } },
        expect: { contains: 'ok' },
      },
    },
  };
  const plan = runner.planFor(plans, TARGET_A, '/tmp/work');
  assert.equal(plan.tool, 'readonly_git_file');
  assert.equal(plan.arguments.workdir, '/tmp/work/git-fixture');
  assert.equal(plan.arguments.nested.file, '/tmp/work/p');
  assert.deepEqual(plan.expect, { contains: 'ok' });
  assert.equal(runner.planFor(plans, TARGET_B, '/tmp/work'), null);
  assert.throws(() => runner.planFor({ plans: { [TARGET_A]: { arguments: {} } } }, TARGET_A, '/tmp/work'), /has no tool/);
});

test('revalidation runner: the shipped plan file only names published record ids', () => {
  const plans = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance', 'revalidation-plans.json'), 'utf8'));
  assert.equal(plans.schemaVersion, 1);
  assert.equal(plans.kind, 'dsh-evolution-revalidation-plans');
  for (const [id, plan] of Object.entries(plans.plans)) {
    assert.match(id, /^evolution-promoted-[a-f0-9]{12}$/);
    assert.equal(typeof plan.tool, 'string');
    assert.ok(plan.tool.length > 0);
    assert.ok(plan.arguments && typeof plan.arguments === 'object' && !Array.isArray(plan.arguments));
  }
});

test('revalidation runner: tool expectations fail on an error, a missing text or a wrong JSON field', () => {
  assert.equal(runner.checkToolExpectation({ name: 'x', isError: false, text: '{"ok":true}' }), null);
  assert.match(runner.checkToolExpectation({ name: 'x', isError: true, text: 'boom' }), /reported an error/);
  assert.match(
    runner.checkToolExpectation({ name: 'x', isError: false, text: 'plain', expect: { contains: 'needle' } }),
    /does not contain/,
  );
  assert.match(
    runner.checkToolExpectation({ name: 'x', isError: false, text: 'not json', expect: { json: { ok: true } } }),
    /is not JSON/,
  );
  assert.match(
    runner.checkToolExpectation({ name: 'x', isError: false, text: '{"ok":false}', expect: { json: { ok: true } } }),
    /returned ok=false/,
  );
  assert.equal(runner.checkToolExpectation({ name: 'x', isError: false, text: '{"ok":true,"n":2}', expect: { json: { ok: true, n: 2 } } }), null);
});

test('revalidation runner: the git fixture is a real repository', (t) => {
  const available = (() => {
    try {
      return String(process.env.PATH || '').split(path.delimiter).some((entry) => {
        try { return fs.existsSync(path.join(entry, 'git')); } catch { return false; }
      });
    } catch { return false; }
  })();
  if (!available) {
    t.skip('git is not on PATH');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-fixture-'));
  try {
    runner.writeGitFixture(directory);
    assert.equal(fs.readFileSync(path.join(directory, 'README.md'), 'utf8').includes('revalidation fixture'), true);
    assert.ok(fs.existsSync(path.join(directory, '.git')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('revalidation runner: help documents the operator command and the adoption flag', () => {
  assert.match(runner.HELP, /--home/);
  assert.match(runner.HELP, /--apply/);
  assert.match(runner.HELP, /--evidence/);
});
test('revalidation runner: the clone keeps relative profile links anchored at the source home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-links-'));
  try {
    const source = path.join(root, 'source');
    // A real DSH home is <parent>/.dsh, so a four-level relative link from
    // <parent>/.dsh/profiles/acp/node_modules resolves inside <parent>.
    const shared = path.join(root, '.local', 'share', 'dsh-plugins', 'thing');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"thing"}');
    const modules = path.join(source, 'profiles', 'acp', 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    // The source link is anchored four levels above node_modules, i.e. at the
    // home's parent, exactly like a real linked profile bundle.
    fs.symlinkSync('../../../../.local/share/dsh-plugins/thing', path.join(modules, 'thing'));
    const clone = path.join(root, 'clone');
    runner.cloneHome(source, clone);
    const link = path.join(clone, 'profiles', 'acp', 'node_modules', 'thing');
    const target = fs.readlinkSync(link);
    assert.equal(path.isAbsolute(target), true, 'the clone link must be absolute');
    assert.equal(target, shared, 'the clone link must point at the source bundle, not inside the clone');
    assert.equal(fs.existsSync(path.join(target, 'package.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('revalidation runner: adoption proofs go to a sidecar and leave the evidence bytes alone', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revalidation-report-'));
  try {
    const evidence = path.join(directory, 'evidence.json');
    const bytes = '{"schemaVersion":1,"kind":"dsh-evolution-cross-entry-evidence"}\n';
    fs.writeFileSync(evidence, bytes);
    const digest = runner.sha256File(evidence);
    assert.equal(runner.adoptionReportPath(evidence), path.join(directory, 'evidence.report.json'));
    assert.equal(runner.adoptionReportPath('/tmp/no-suffix'), '/tmp/no-suffix.report.json');
    const reportFile = runner.writeAdoptionReport(evidence, { evidenceSha256: digest, adoption: { ok: true } });
    assert.equal(reportFile, path.join(directory, 'evidence.report.json'));
    // The index pins the evidence digest; a post-adoption rewrite would orphan it.
    assert.equal(fs.readFileSync(evidence, 'utf8'), bytes);
    assert.equal(runner.sha256File(evidence), digest);
    assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')), { evidenceSha256: digest, adoption: { ok: true } });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('revalidation runner: an out-of-root module URL is skipped-invalid against the real plugin root', () => {
  const THIRD = 'evolution-promoted-cccccccccccc';
  const sourceRoot = '/tmp/root/promoted';
  const elsewhereRoot = '/tmp/elsewhere/promoted';
  const moduleUrlAt = (root, id) => pathToFileURL(path.join(root, `dsh-${id}`, 'lib', 'index.js')).href;
  const records = [
    validRecord(TARGET_A, {
      moduleUrl: moduleUrlAt(sourceRoot, TARGET_A),
      supersededBy: { acp: validMarker(TARGET_B, 'b'.repeat(64)) },
    }),
    validRecord(TARGET_B, {
      moduleUrl: moduleUrlAt(elsewhereRoot, TARGET_B),
      sourceSha256: 'b'.repeat(64),
      supersededBy: { acp: validMarker(THIRD, 'c'.repeat(64)) },
    }),
    validRecord(THIRD, {
      moduleUrl: moduleUrlAt(sourceRoot, THIRD),
      sourceSha256: 'c'.repeat(64),
    }),
  ];
  // B is operator-disabled in acp and has no isolated boot; A and C did boot.
  const bootStatuses = new Map([
    [TARGET_A, { status: 'active' }],
    [THIRD, { status: 'active' }],
  ]);
  const disable = { entries: [{ pluginId: TARGET_B, profile: 'acp' }] };
  const result = runner.expectedAfterAdoption(records, 'acp', bootStatuses, disable, sourceRoot);
  assert.deepEqual(result.get(TARGET_B), { status: 'skipped-invalid', reason: 'record-module-path' },
    'the real promoted root must invalidate a module URL that points outside it');
  assert.equal(result.get(TARGET_A).status, 'eligible',
    'an invalid middle link must not suppress its still-active predecessor');
  // The runner and the production consumer apply the very same validator.
  assert.deepEqual(validateSharedRecord(records[1], { pluginRoot: sourceRoot }), { ok: false, reason: 'record-module-path' });
});

test('revalidation runner: operator revocation outranks a missing profile approval', () => {
  const record = validRecord(TARGET_A, { approvedProfiles: ['web'] });
  const disable = { entries: [{ pluginId: TARGET_A, profile: 'acp' }] };
  const result = runner.expectedAfterAdoption([record], 'acp', new Map(), disable, '/clone/promoted');
  assert.deepEqual(result.get(TARGET_A), { status: 'disabled', reason: 'operator-disabled' },
    'production checks revocation before profile approval, so the runner must too');
});

test('revalidation runner: evidence redaction covers the home, the scratch tree and the repository root', () => {
  const home = path.join(os.tmpdir(), 'redact-home');
  const work = path.join(os.tmpdir(), 'redact-work');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const redacted = runner.redact({
    home,
    work,
    probe: path.join(repoRoot, 'scripts', 'acceptance', 'probes', 'cross-entry-consumer-probe.mjs'),
    texts: [home + '/storages', work + '/logs'],
  }, home, work);
  assert.equal(redacted.home, '$DSH_HOME');
  assert.equal(redacted.work, '<work>');
  assert.equal(redacted.probe, '<repo>/scripts/acceptance/probes/cross-entry-consumer-probe.mjs');
  assert.deepEqual(redacted.texts, ['$DSH_HOME/storages', '<work>/logs']);
});
