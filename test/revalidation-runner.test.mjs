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

test('revalidation runner: a superseded record is expected disabled while its replacement is a target', () => {
  const replacement = { id: TARGET_B, approvedProfiles: ['acp', 'web'], sourceSha256: 'b'.repeat(64) };
  const previous = {
    id: TARGET_A,
    approvedProfiles: ['acp', 'web'],
    supersededBy: { acp: { recordId: TARGET_B, sourceSha256: 'b'.repeat(64) } },
  };
  assert.deepEqual(runner.expectedRecordStatus(previous, 'acp', [previous, replacement], { entries: [] }), { status: 'disabled', reason: 'superseded-by' });
  assert.deepEqual(runner.expectedRecordStatus(previous, 'web', [previous, replacement], { entries: [] }), { status: 'active' });
  // A changed replacement digest or a revoked replacement restores the old plugin.
  const tampered = { ...replacement, sourceSha256: 'c'.repeat(64) };
  assert.deepEqual(runner.expectedRecordStatus(previous, 'acp', [previous, tampered], { entries: [] }), { status: 'active' });
  const revoked = { entries: [{ pluginId: TARGET_B, profile: 'acp' }] };
  assert.deepEqual(runner.expectedRecordStatus(previous, 'acp', [previous, replacement], revoked), { status: 'active' });
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
