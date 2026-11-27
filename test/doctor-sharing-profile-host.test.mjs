// Profile-attributed host diagnostics for shared promotions. Every fixture is
// synthetic: the doctor must neither start an entry nor mutate the data root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';
import {
  consumerStateDocument,
  publishSharedRecord,
  setDisabledForProfile,
  writeConsumerState,
} from '../lib/promoted-sharing.js';

const HEX = (value) => crypto.createHash('sha256').update(value).digest('hex');
const PLUGIN_NAME = 'dsh-evolution-promoted-af973a3eea01';
const PLUGIN_ID = 'evolution-promoted-af973a3eea01';
const VERIFIED_HOST = Object.freeze({
  profile: 'desktop',
  dsh: '0.2.2-rc.5',
  cordis: '4.1.0',
  include: '1.1.0',
  node: process.version,
  capturedAt: '2026-11-27T11:00:00.000Z',
});
const WEB_HOST = Object.freeze({
  profile: 'web',
  dsh: '0.2.2-rc.1',
  cordis: '4.1.0',
  include: '1.1.0',
  node: 'v22.19.0',
  capturedAt: '2026-11-27T11:49:25.000Z',
});
const ACP_HOST = Object.freeze({ ...VERIFIED_HOST, profile: 'acp' });

function makeHost(root, version) {
  const modules = path.join(root, 'node_modules');
  for (const [name, packageVersion] of [
    ['@deepseek-ai/dsh', version],
    ['@deepseek-ai/cordis', '4.1.0'],
    ['@deepseek-ai/cordis-plugin-include', '1.1.0'],
  ]) {
    const dir = path.join(modules, name);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: packageVersion })}\n`);
    if (name === '@deepseek-ai/dsh') {
      fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), 'export {};\n');
    }
  }
  return path.join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function makeWrapper(file, { acp, fallback }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh
case "$1:$2" in
  --profile:acp)
    exec ${process.execPath} "${acp}" "$@"
    ;;
  --profile:web)
    exec ${process.execPath} "${fallback}" "$@"
    ;;
  *)
    exec ${process.execPath} "${fallback}" "$@"
    ;;
esac
`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dshHome = path.join(root, 'home');
  const paths = resolveEvolutionPaths({ dshHome });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, 'c'.repeat(64), { mode: 0o600 });
  const profileDir = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'dsh-evolution'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({ name: 'web', dsh: { profile: { bundles: ['dsh-evolution'] } } })}\n`);
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'dsh-evolution', 'package.json'), `${JSON.stringify({ name: 'dsh-evolution', version: '0.2.23' })}\n`);

  const pluginDir = path.join(paths.pluginRoot, PLUGIN_NAME);
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  const source = 'export const name = "shared";\nexport const inject = ["tools"];\nexport function apply() {}\n';
  const manifest = `${JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0', type: 'module', main: 'lib/index.js' })}\n`;
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  fs.writeFileSync(modulePath, source);
  fs.writeFileSync(path.join(pluginDir, 'package.json'), manifest);

  const acpBin = makeHost(path.join(root, 'host-rc5'), '0.2.2-rc.5');
  const webBin = makeHost(path.join(root, 'host-rc1'), '0.2.2-rc.1');
  const wrapper = makeWrapper(path.join(root, 'bin', 'dsh'), { acp: acpBin, fallback: webBin });
  const singleBin = makeHost(path.join(root, 'host-single'), '0.2.2-rc.5');
  const singleWrapper = makeWrapper(path.join(root, 'bin-single', 'dsh'), { acp: singleBin, fallback: singleBin });

  const record = {
    id: PLUGIN_ID,
    schemaVersion: 1,
    experimentId: 'exp-doctor-profile-host',
    pluginName: PLUGIN_NAME,
    moduleUrl: pathToFileURL(modulePath).href,
    entry: 'lib/index.js',
    sourceSha256: HEX(source),
    manifestSha256: HEX(manifest),
    publisherProfile: 'desktop',
    approvedProfiles: ['acp', 'web'],
    stable: {
      committedAt: '2026-11-27T11:00:00.000Z',
      promotionTimestamp: '2026-11-27T11:00:00.000Z',
      decision: 'benefit',
      canary: { healthObservationWindow: 2, observations: 2, startupVerified: true },
    },
    requiredServices: ['tools'],
    serviceMembers: {},
    requiredCapabilities: ['fiberLifecycle', 'fiberAwait', 'include', 'toolsRegistry'],
    hostOnly: true,
    host: VERIFIED_HOST,
    revalidation: [],
    publishedAt: '2026-11-27T11:00:00.000Z',
  };
  const published = await publishSharedRecord(paths, record);
  assert.equal(published.status, 'published');
  const index = JSON.parse(await fsp.readFile(path.join(paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));

  await writeConsumerState(paths, 'acp', consumerStateDocument({
    profile: 'acp', host: ACP_HOST, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: PLUGIN_ID, status: 'active', reason: null }],
  }));
  await writeConsumerState(paths, 'web', consumerStateDocument({
    profile: 'web', host: WEB_HOST, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: PLUGIN_ID, status: 'pending-revalidation', reason: 'host-version-mismatch' }],
  }));
  return { root, dshHome, paths, wrapper, singleWrapper, index, acpBin, webBin };
}

const checkOf = (report, id) => report.checks.find((check) => check.id === id);
const sharingOf = (report) => checkOf(report, 'promotion.sharing');
const recordOf = (report) => sharingOf(report).evidence.records.find((row) => row.id === PLUGIN_ID);

async function diagnose(env, profile, cliPath = env.wrapper) {
  const savedPath = process.env.PATH;
  const savedDshCli = process.env.DSH_CLI;
  process.env.PATH = path.join(env.root, 'empty-bin');
  delete process.env.DSH_CLI;
  try {
    return await collectDiagnostics({
      dshHome: env.dshHome,
      profile,
      cliPath,
      probe: { skipComposition: true },
    });
  } finally {
    process.env.PATH = savedPath;
    if (savedDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = savedDshCli;
  }
}

function snapshotTree(root) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else rows.push([path.relative(root, file), fs.readFileSync(file), fs.statSync(file).mtimeMs]);
    }
  };
  visit(root);
  return rows;
}

test('web host facts and verified host facts disagree without a contradictory compatible verdict', async (t) => {
  const env = await fixture(t);
  const before = snapshotTree(env.paths.dataRoot);
  const result = spawnSync(process.execPath, [
    path.resolve('scripts/doctor.mjs'), '--home', env.dshHome, '--profile', 'web',
    '--dsh-cli', env.wrapper, '--json', '--no-composition',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path.join(env.root, 'empty-bin'), DSH_CLI: '' },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(snapshotTree(env.paths.dataRoot), before, 'doctor must remain read-only');

  const sharing = sharingOf(report);
  assert.equal(sharing.level, 'degraded');
  assert.equal(sharing.evidence.consumers.web.host.dsh, '0.2.2-rc.1');
  assert.equal(sharing.evidence.consumers.web.host.cordis, '4.1.0');
  assert.equal(sharing.evidence.consumers.web.host.include, '1.1.0');
  assert.equal(sharing.evidence.consumers.web.host.node, 'v22.19.0');
  assert.equal(recordOf(report).hostCompatible, false);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.ok, false);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.reason, 'host-version-mismatch');
  assert.deepEqual(sharing.evidence.hostMismatches.map((row) => ({
    profile: row.profile,
    recordId: row.recordId,
    consumerDsh: row.consumerHost.dsh,
    verifiedDsh: row.verifiedHost.dsh,
    reason: row.reason,
  })), [{
    profile: 'web', recordId: PLUGIN_ID, consumerDsh: '0.2.2-rc.1',
    verifiedDsh: '0.2.2-rc.5', reason: 'host-version-mismatch',
  }]);
  assert.match(sharing.summary, /web/);
  assert.match(sharing.summary, /0\.2\.2-rc\.1/);
  assert.match(sharing.summary, /0\.2\.2-rc\.5/);
  assert.match(sharing.remediation, /align.*web.*0\.2\.2-rc\.5.*restart/i);
  assert.match(sharing.remediation, /same.*bytes/i);
  assert.match(sharing.remediation, /0\.2\.2-rc\.1/);
  assert.match(sharing.remediation, /revalidate --evidence/);
  assert.match(sharing.remediation, /--data-root/);
  assert.match(sharing.remediation, /single verified host.*every approved profile/i);
  assert.match(sharing.remediation, /restart affected consumers/i);
});

test('acp remains compatible while a multi-version wrapper is not silently attributed to the profile', async (t) => {
  const env = await fixture(t);
  const report = await diagnose(env, 'acp');
  const cli = checkOf(report, 'host.cli');
  const version = checkOf(report, 'host.version');
  assert.equal(cli.evidence.profileHostAmbiguous, true);
  assert.equal(cli.evidence.profileHost, null);
  assert.match(cli.summary, /multiple DSH CLI candidates/i);
  assert.match(cli.remediation, /--dsh-cli/);
  assert.equal(version.level, 'not-evaluated');
  assert.equal(version.evidence.found, null);
  assert.equal(version.evidence.reason, 'profile-host-ambiguous');
  assert.equal(sharingOf(report).evidence.observedHost, null);
  assert.equal(sharingOf(report).evidence.observedHostReason, 'profile-host-ambiguous');
  assert.equal(recordOf(report).hostCompatible, true);
  assert.equal(recordOf(report).hostCompatibleByProfile.acp.ok, true);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.ok, false);
});

test('a single-version wrapper keeps host.cli attribution and adds no sharing noise', async (t) => {
  const env = await fixture(t);
  const index = JSON.parse(await fsp.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState(env.paths, 'web', consumerStateDocument({
    profile: 'web', host: { ...VERIFIED_HOST, profile: 'web' }, indexUpdatedAt: index.updatedAt,
    compositionPath: null, plugins: [{ id: PLUGIN_ID, status: 'active', reason: null }],
  }));
  const report = await diagnose(env, 'web', env.singleWrapper);
  const cli = checkOf(report, 'host.cli');
  assert.equal(cli.level, 'ok');
  assert.equal(cli.evidence.source, 'argument');
  assert.equal(cli.evidence.profileHostAmbiguous, undefined);
  assert.match(cli.summary, /@deepseek-ai\/dsh@0\.2\.2-rc\.5/);
  assert.equal(checkOf(report, 'host.version').evidence.found, '0.2.2-rc.5');
  assert.equal(sharingOf(report).level, 'ok');
  assert.deepEqual(sharingOf(report).evidence.hostMismatches, []);
  assert.equal(recordOf(report).hostCompatible, true);
});

test('a consumer that has not observed the current index still needs restart, not host mismatch', async (t) => {
  const env = await fixture(t);
  await writeConsumerState(env.paths, 'web', consumerStateDocument({
    profile: 'web', host: WEB_HOST, indexUpdatedAt: '2020-01-01T00:00:00.000Z', compositionPath: null,
    plugins: [{ id: PLUGIN_ID, status: 'pending-revalidation', reason: 'host-version-mismatch' }],
  }));
  const report = await diagnose(env, 'web');
  const sharing = sharingOf(report);
  assert.deepEqual(sharing.evidence.hostMismatches, []);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.status, 'restart-required');
  assert.equal(recordOf(report).hostCompatibleByProfile.web.reason, 'index-changed-since-consumer-start');
  assert.deepEqual(sharing.evidence.inactiveConsumers.find((row) => row.profile === 'web'), {
    profile: 'web', id: PLUGIN_ID, status: 'restart-required',
    reason: 'index-changed-since-consumer-start',
  });
  assert.match(sharing.summary, /web.*restart/i);
  assert.doesNotMatch(sharing.summary, /host-version-mismatch|0\.2\.2-rc\.1/);
  assert.match(sharing.remediation, /restart.*web/i);
});

test('without a diagnosed profile, only consumer receipts create compatibility problems', async (t) => {
  const env = await fixture(t);
  const index = JSON.parse(await fsp.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState(env.paths, 'web', consumerStateDocument({
    profile: 'web', host: { ...VERIFIED_HOST, profile: 'web' }, indexUpdatedAt: index.updatedAt,
    compositionPath: null, plugins: [{ id: PLUGIN_ID, status: 'active', reason: null }],
  }));
  const report = await diagnose(env, null, null);
  const sharing = sharingOf(report);
  assert.equal(checkOf(report, 'host.cli').level, 'not-evaluated');
  assert.equal(sharing.level, 'ok', JSON.stringify(sharing.evidence));
  assert.deepEqual(sharing.evidence.problems, []);
  assert.deepEqual(sharing.evidence.hostMismatches, []);
  assert.equal(recordOf(report).hostCompatible, true);
});

test('a revoked profile keeps its old host refusal historical', async (t) => {
  const env = await fixture(t);
  await setDisabledForProfile(env.paths, { pluginId: PLUGIN_ID, profile: 'web', disabled: true });
  const report = await diagnose(env, 'web');
  const sharing = sharingOf(report);
  assert.equal(sharing.level, 'ok', JSON.stringify(sharing.evidence));
  assert.deepEqual(sharing.evidence.hostMismatches, []);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.status, 'disabled');
  assert.equal(recordOf(report).hostCompatibleByProfile.web.reason, 'operator-disabled');
});

test('an Include startup failure is not reclassified as host revalidation', async (t) => {
  const env = await fixture(t);
  const index = JSON.parse(await fsp.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState(env.paths, 'web', consumerStateDocument({
    profile: 'web', host: WEB_HOST, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: PLUGIN_ID, status: 'failed', reason: 'include-unavailable' }],
  }));
  const report = await diagnose(env, 'web');
  const sharing = sharingOf(report);
  assert.deepEqual(sharing.evidence.hostMismatches, []);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.status, 'failed');
  assert.equal(recordOf(report).hostCompatibleByProfile.web.reason, 'include-unavailable');
  assert.ok(sharing.evidence.deadConsumers.some((row) => row.profile === 'web' && row.reason === 'include-unavailable'));
  assert.match(sharing.summary, /include-unavailable.*before plugin evaluation/i);
  assert.match(sharing.remediation, /Include host capability.*restart web/i);
  assert.match(sharing.remediation, /revalidating plugin bytes cannot repair/i);
});

test('an operator reset keeps the old host receipt but waits for restart before compatibility', async (t) => {
  const env = await fixture(t);
  const index = JSON.parse(await fsp.readFile(path.join(env.paths.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  await writeConsumerState(env.paths, 'web', consumerStateDocument({
    profile: 'web', host: WEB_HOST, indexUpdatedAt: index.updatedAt, compositionPath: null,
    plugins: [{ id: PLUGIN_ID, status: 'pending-restart', reason: 'operator-reset' }],
  }));
  const report = await diagnose(env, null, null);
  const sharing = sharingOf(report);
  assert.deepEqual(sharing.evidence.hostMismatches, []);
  assert.equal(recordOf(report).hostCompatible, null);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.ok, null);
  assert.equal(recordOf(report).hostCompatibleByProfile.web.status, 'restart-required');
  assert.equal(recordOf(report).hostCompatibleByProfile.web.reason, 'operator-reset');
  assert.deepEqual(sharing.evidence.inactiveConsumers.find((row) => row.profile === 'web'), {
    profile: 'web', id: PLUGIN_ID, status: 'restart-required', reason: 'operator-reset',
  });
});

test('tampered source keeps the blocking digest failure without host revalidation advice', async (t) => {
  const env = await fixture(t);
  fs.writeFileSync(path.join(env.paths.pluginRoot, PLUGIN_NAME, 'lib', 'index.js'), 'tampered bytes');
  const report = await diagnose(env, 'web');
  const sharing = sharingOf(report);
  assert.equal(sharing.level, 'blocked');
  assert.equal(recordOf(report).source, 'source-digest-mismatch');
  assert.deepEqual(sharing.evidence.hostMismatches, []);
  assert.match(sharing.summary, /on-disk source/i);
  assert.doesNotMatch(sharing.summary, /Current-index consumer host mismatch/);
  assert.doesNotMatch(sharing.remediation, /revalidate --evidence|align web/);
  assert.match(sharing.remediation, /Re-promote through Desktop/);
});

test('an inline if launch branch leaves the wrapper host unknown', async (t) => {
  const env = await fixture(t);
  const wrapper = path.join(env.root, 'inline-if-dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1:$2" = '--profile:web' ]; then exec node "${env.webBin}" "$@"; fi
exec ${process.execPath} "${env.acpBin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  const report = await diagnose(env, 'web', wrapper);
  assert.equal(checkOf(report, 'host.cli').level, 'not-evaluated');
});

test('a complete one-line case leaves the wrapper host unknown', async (t) => {
  const env = await fixture(t);
  const wrapper = path.join(env.root, 'one-line-case-dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1:$2" in --profile:web) exec node "${env.webBin}" "$@" ;; *) exec ${process.execPath} "${env.acpBin}" "$@" ;; esac
exec ${process.execPath} "${env.acpBin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  const report = await diagnose(env, 'web', wrapper);
  assert.equal(checkOf(report, 'host.cli').level, 'not-evaluated');
});

test('two case branches on one line leave the wrapper host unknown', async (t) => {
  const env = await fixture(t);
  const wrapper = path.join(env.root, 'shared-line-case-dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1:$2" in
  --profile:web) exec node "${env.webBin}" "$@" ;; --profile:acp) exec ${process.execPath} "${env.acpBin}" "$@" ;;
  *) exec ${process.execPath} "${env.acpBin}" "$@" ;;
esac
`);
  fs.chmodSync(wrapper, 0o755);
  const report = await diagnose(env, 'web', wrapper);
  assert.equal(checkOf(report, 'host.cli').level, 'not-evaluated');
});

test('a case branch with a PATH-launched node target leaves the wrapper host unknown', async (t) => {
  const env = await fixture(t);
  const wrapper = path.join(env.root, 'path-node-case-dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1:$2" in
  --profile:web)
    exec node "${env.webBin}" "$@"
    ;;
  *)
    exec ${process.execPath} "${env.acpBin}" "$@"
    ;;
esac
`);
  fs.chmodSync(wrapper, 0o755);
  const report = await diagnose(env, 'web', wrapper);
  const cli = checkOf(report, 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.equal(cli.evidence.reason, 'cli-candidate-unresolved');
  assert.match(cli.summary, /path-node-case-dsh:4 \(UNRESOLVED_EXEC_TARGET: the launch command/);
});

test('an unsupported case launch body leaves the profile host unknown', async (t) => {
  const env = await fixture(t);
  const wrapper = path.join(env.root, 'unsupported-case-dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in
  --profile)
    "${env.singleWrapper}" "$@"
    ;;
  *) exec /bin/false "$@" ;;
esac
`);
  fs.chmodSync(wrapper, 0o755);
  const report = await diagnose(env, 'web', wrapper);
  const cli = checkOf(report, 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.equal(cli.evidence.reason, 'cli-candidate-unresolved');
  assert.match(cli.summary, /NO_EXEC_TARGET/);
});
