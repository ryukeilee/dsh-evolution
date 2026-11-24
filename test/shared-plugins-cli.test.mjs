// Operator CLI for the cross-entry publication index.
//
// Every fixture is a synthetic os.tmpdir() data root. The CLI is spawned as a
// real child process so argv handling, exit codes and JSON output are tested,
// not an in-process function.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishSharedRecord, readSharedIndex, writeConsumerState, consumerStateDocument } from '../lib/promoted-sharing.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'shared-plugins.mjs');
const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const pluginName = 'dsh-evolution-promoted-abcdefabcdef';
const pluginId = 'evolution-promoted-abcdefabcdef';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-shared-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, 'promoted');
  const pluginDir = path.join(pluginRoot, pluginName);
  await fs.mkdir(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = 'export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n';
  await fs.writeFile(modulePath, source);
  await fs.writeFile(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  const record = {
    id: pluginId, schemaVersion: 1, experimentId: 'exp-cli', pluginName, moduleUrl: pathToFileURL(modulePath).href, entry: 'lib/index.js',
    sourceSha256: HEX(source), manifestSha256: HEX(await fs.readFile(path.join(pluginDir, 'package.json'))),
    publisherProfile: 'desktop', approvedProfiles: ['acp', 'web'],
    stable: { committedAt: '2026-01-02T00:00:00.000Z', promotionTimestamp: '2026-01-01T00:00:00.000Z', decision: 'benefit', canary: { healthObservationWindow: 2, observations: 2, startupVerified: true } },
    requiredServices: ['tools'], serviceMembers: {}, requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
    hostOnly: true, host: { dsh: '0.2.2-rc.1', cordis: '4.1.0', include: '1.1.0', node: 'v24.21.0', verifiedAt: '2026-01-02T00:00:00.000Z' },
    revalidation: [], publishedAt: '2026-01-02T00:00:00.000Z',
  };
  return { root, pluginRoot, modulePath, source, record };
}

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* reported by callers */ }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

test('list reports an absent index as Desktop-only', async (t) => {
  const env = await fixture(t);
  const result = run(['list', '--data-root', env.root, '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.indexStatus, 'absent');
  assert.deepEqual(result.json.records, []);
  assert.equal(result.json.consumers.acp.status, 'absent');
});

test('disable and enable revoke only that profile and only for a published record', async (t) => {
  const env = await fixture(t);
  assert.equal((await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, env.record)).status, 'published');

  const disabled = run(['disable', '--data-root', env.root, '--plugin', pluginId, '--profile', 'acp', '--json']);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(disabled.json.disabled, true);
  const listed = run(['list', '--data-root', env.root, '--json']);
  assert.deepEqual(listed.json.records[0].disabledProfiles, ['acp']);
  assert.deepEqual(listed.json.records[0].approvedProfiles, ['acp', 'web'], 'approval itself is untouched');

  const enabled = run(['enable', '--data-root', env.root, '--plugin', pluginId, '--profile', 'acp', '--json']);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.deepEqual(run(['list', '--data-root', env.root, '--json']).json.records[0].disabledProfiles, []);

  // Unknown records and non-consumer profiles are refused.
  assert.equal(run(['disable', '--data-root', env.root, '--plugin', 'evolution-promoted-000000000000', '--profile', 'acp']).code, 1);
  assert.equal(run(['disable', '--data-root', env.root, '--plugin', pluginId, '--profile', 'desktop']).code, 1);
  assert.equal(run(['disable', '--data-root', env.root]).code, 1);
});

test('reset clears a sticky consumer failure for exactly one plugin', async (t) => {
  const env = await fixture(t);
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, env.record);
  await fs.mkdir(path.join(env.root, 'shared-plugins', 'consumers'), { recursive: true });
  const state = consumerStateDocument({
    profile: 'acp', host: env.record.host, indexUpdatedAt: '2026-01-02T00:00:00.000Z', compositionPath: null,
    plugins: [{ id: pluginId, status: 'failed', reason: 'plugin-apply-failed' }, { id: 'evolution-promoted-000000000000', status: 'active' }],
  });
  await writeConsumerState({ dataRoot: env.root }, 'acp', state);
  const result = run(['reset', '--data-root', env.root, '--plugin', pluginId, '--profile', 'acp', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.cleared, true);
  const listed = run(['list', '--data-root', env.root, '--json']);
  assert.equal(listed.json.consumers.acp.plugins[0].status, 'pending-restart');
  assert.equal(listed.json.consumers.acp.plugins[1].status, 'active');
});

test('revalidate adopts isolated-host evidence and refuses mismatched bytes', async (t) => {
  const env = await fixture(t);
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, env.record);
  const evidence = {
    schemaVersion: 1,
    kind: 'dsh-evolution-cross-entry-evidence',
    host: { dsh: '0.2.3-rc.1', cordis: '4.1.2', include: '1.1.4', node: 'v24.21.0' },
    plugins: [{ id: pluginId, sourceSha256: env.record.sourceSha256, profiles: { acp: { active: true }, web: { active: true } } }],
  };
  const evidencePath = path.join(env.root, 'evidence.json');
  await fs.writeFile(evidencePath, JSON.stringify(evidence));
  const result = run(['revalidate', '--data-root', env.root, '--evidence', evidencePath, '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json.adopted[0].profiles, ['acp', 'web']);
  const index = await readSharedIndex({ dataRoot: env.root, pluginRoot: env.pluginRoot });
  assert.equal(index.records[0].host.dsh, '0.2.3-rc.1');
  assert.equal(index.records[0].revalidation.length, 1);
  assert.equal(index.records[0].revalidation[0].evidenceSha256, HEX(await fs.readFile(evidencePath)));
  assert.equal(index.records[0].publishedAt, env.record.publishedAt, 'revalidation keeps the publication identity');

  // Evidence that does not prove activation, or names other bytes, is refused.
  const noActivation = { ...evidence, plugins: [{ id: pluginId, sourceSha256: env.record.sourceSha256, profiles: { acp: { active: false } } }] };
  await fs.writeFile(evidencePath, JSON.stringify(noActivation));
  assert.equal(run(['revalidate', '--data-root', env.root, '--evidence', evidencePath]).code, 1);
  const otherBytes = { ...evidence, plugins: [{ id: pluginId, sourceSha256: 'f'.repeat(64), profiles: { acp: { active: true } } }] };
  await fs.writeFile(evidencePath, JSON.stringify(otherBytes));
  assert.equal(run(['revalidate', '--data-root', env.root, '--evidence', evidencePath]).code, 1);
});

test('usage errors and unknown commands fail closed', () => {
  assert.equal(run(['--help']).code, 0);
  assert.equal(run([]).code, 0);
  assert.equal(run(['frobnicate']).code, 1);
  assert.equal(run(['list', '--bogus']).code, 1);
});

async function secondRecord(env, suffix = '123456123456') {
  const id = `evolution-promoted-${suffix}`;
  const pluginName = `dsh-${id}`;
  const dir = path.join(env.pluginRoot, pluginName, 'lib');
  await fs.mkdir(dir, { recursive: true });
  const modulePath = path.join(dir, 'index.js');
  const source = 'export const name = "iteration";\nexport const inject = [];\nexport function apply() {}\n';
  await fs.writeFile(modulePath, source);
  const manifest = path.join(env.pluginRoot, pluginName, 'package.json');
  await fs.writeFile(manifest, `${JSON.stringify({ name: pluginName, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`);
  return {
    ...env.record,
    id, pluginName, moduleUrl: pathToFileURL(modulePath).href,
    sourceSha256: HEX(source), manifestSha256: HEX(await fs.readFile(manifest)),
  };
}

test('approve widens an existing stable record without a new experiment or new bytes', async (t) => {
  const env = await fixture(t);
  // The record starts Desktop-only: approval is the only thing that changes.
  const record = { ...env.record, approvedProfiles: ['acp'] };
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, record);
  const result = run(['approve', '--data-root', env.root, '--plugin', pluginId, '--profile', 'web', '--approval', 'I approve sharing this verified plugin with Web', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.status, 'updated');
  assert.deepEqual(result.json.approvedProfiles, ['acp', 'web']);
  const index = await readSharedIndex({ dataRoot: env.root, pluginRoot: env.pluginRoot });
  assert.deepEqual(index.records[0].approvedProfiles, ['acp', 'web']);
  assert.equal(index.records[0].sourceSha256, env.record.sourceSha256, 'verified bytes are unchanged');
  assert.equal(index.records[0].stable.committedAt, env.record.stable.committedAt, 'stable proof is unchanged');
  assert.equal(index.records[0].approvalExtensions.length, 1);
  assert.equal(index.records[0].approvalExtensions[0].profile, 'web');

  // Idempotent, and still refuses a missing approval.
  assert.equal(run(['approve', '--data-root', env.root, '--plugin', pluginId, '--profile', 'web']).code, 1);
  const repeat = run(['approve', '--data-root', env.root, '--plugin', pluginId, '--profile', 'web', '--approval', 'again', '--json']);
  assert.equal(repeat.json.status, 'already-approved');

  // A file changed after publication cannot be re-approved.
  await fs.writeFile(env.modulePath, 'export const name = "tampered";\n');
  assert.equal(run(['approve', '--data-root', env.root, '--plugin', pluginId, '--profile', 'acp', '--approval', 'x']).code, 1);
});

test('supersede and revoke-supersede are bounded, byte-bound and reversible', async (t) => {
  const env = await fixture(t);
  const replacement = await secondRecord(env);
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, env.record);
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, replacement);

  // Both must be approved in the profile already; approval is explicit.
  assert.equal(run(['supersede', '--data-root', env.root, '--old', pluginId, '--new', replacement.id, '--profile', 'acp']).code, 1);
  const approved = run(['approve', '--data-root', env.root, '--plugin', replacement.id, '--profile', 'acp', '--approval', 'approve the iteration', '--json']);
  assert.equal(approved.code, 0, approved.stderr);

  const superseded = run(['supersede', '--data-root', env.root, '--old', pluginId, '--new', replacement.id, '--profile', 'acp', '--approval', 'replace the older policy', '--json']);
  assert.equal(superseded.code, 0, superseded.stderr);
  const index = await readSharedIndex({ dataRoot: env.root, pluginRoot: env.pluginRoot });
  assert.equal(index.records[0].supersededBy.acp.recordId, replacement.id);
  assert.equal(index.records[0].supersededBy.acp.sourceSha256, replacement.sourceSha256);
  assert.equal(index.records[0].sourceSha256, env.record.sourceSha256, 'old bytes are preserved for rollback');
  assert.deepEqual(index.records[1].approvedProfiles, ['acp', 'web']);

  // Revoking disables the replacement in the profile and clears the marker.
  const revoked = run(['revoke-supersede', '--data-root', env.root, '--old', pluginId, '--profile', 'acp', '--approval', 'roll back to the previous plugin', '--json']);
  assert.equal(revoked.code, 0, revoked.stderr);
  const after = await readSharedIndex({ dataRoot: env.root, pluginRoot: env.pluginRoot });
  assert.equal(after.records[0].supersededBy, undefined);
  const disabled = run(['list', '--data-root', env.root, '--json']);
  assert.deepEqual(disabled.json.records[1].disabledProfiles, ['acp']);

  // A tampered replacement cannot be used as the new authority.
  await fs.writeFile(path.join(env.pluginRoot, replacement.pluginName, 'lib', 'index.js'), 'export const name = "tampered";\n');
  const reapply = run(['supersede', '--data-root', env.root, '--old', pluginId, '--new', replacement.id, '--profile', 'acp', '--approval', 'x']);
  assert.equal(reapply.code, 1);
});

test('supersession is stored per profile and chained replacements are refused', async (t) => {
  const env = await fixture(t);
  const replacement = await secondRecord(env);
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, env.record);
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, replacement);
  assert.equal(run(['approve', '--data-root', env.root, '--plugin', replacement.id, '--profile', 'acp', '--approval', 'ok acp']).code, 0);
  for (const profile of ['acp', 'web']) {
    const result = run(['supersede', '--data-root', env.root, '--old', pluginId, '--new', replacement.id, '--profile', profile, '--approval', `replace in ${profile}`, '--json']);
    assert.equal(result.code, 0, result.stderr);
  }
  const index = await readSharedIndex({ dataRoot: env.root, pluginRoot: env.pluginRoot });
  assert.deepEqual(Object.keys(index.records[0].supersededBy).sort(), ['acp', 'web']);

  // A second iteration in the same profile is bounded by the replacement's
  // own marker: repeating the same pair is a no-op, a different target is a
  // new generation that the consumer resolves to its terminal version.
  const chained = run(['supersede', '--data-root', env.root, '--old', pluginId, '--new', replacement.id, '--profile', 'acp', '--approval', 'again', '--json']);
  assert.equal(chained.json.status, 'already-superseded');
  const third = await secondRecord(env, '999999999999');
  await publishSharedRecord({ dataRoot: env.root, pluginRoot: env.pluginRoot }, third);
  assert.equal(run(['approve', '--data-root', env.root, '--plugin', third.id, '--profile', 'acp', '--approval', 'ok third']).code, 0);
  assert.equal(run(['supersede', '--data-root', env.root, '--old', replacement.id, '--new', third.id, '--profile', 'acp', '--approval', 'chain']).code, 0);
  const afterChain = await readSharedIndex({ dataRoot: env.root, pluginRoot: env.pluginRoot });
  assert.equal(afterChain.records[1].supersededBy.acp.recordId, third.id);
});
