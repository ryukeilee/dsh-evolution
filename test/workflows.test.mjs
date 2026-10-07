/**
 * The GitHub workflows are part of the release contract: a syntax error in one
 * of them means the repository has no working CI, and GitHub only reports that
 * when the workflow is next triggered. Parse them here instead, and assert the
 * properties the release process depends on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(workflowsDir, name), 'utf8'));
}

function stepNames(job) {
  return (job.steps || []).map((step) => step.name || step.uses).filter(Boolean);
}

function usedActions(workflow) {
  const uses = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps || []) if (step.uses) uses.push(step.uses);
  }
  return uses;
}

function releaseWorkflowRuns() {
  const release = loadWorkflow('release.yml');
  return release.jobs.release.steps.map((step) => step.run).filter(Boolean).join('\n');
}

test('every workflow file parses as YAML and has runnable steps', () => {
  const files = fs.readdirSync(workflowsDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  assert.ok(files.length >= 2, `expected at least two workflow files, found ${files.length}`);
  for (const name of files) {
    const workflow = loadWorkflow(name);
    assert.ok(workflow && typeof workflow === 'object', `${name} did not parse to a mapping`);
    assert.ok(workflow.jobs && Object.keys(workflow.jobs).length > 0, `${name} declares no jobs`);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      assert.ok(job['runs-on'], `${name}:${jobName} has no runs-on`);
      assert.ok(Array.isArray(job.steps) && job.steps.length > 0, `${name}:${jobName} has no steps`);
      for (const step of job.steps) {
        assert.ok(step.uses || step.run, `${name}:${jobName} has a step with neither uses nor run`);
        // `uses` steps may rely on the action's own name; a shell step that
        // shows up unnamed in the UI is a review smell.
        if (step.run) assert.ok(step.name, `${name}:${jobName} has an unnamed run step`);
      }
    }
  }
});

test('CI runs the unit tests, the package checks and both supported hosts', () => {
  const ci = loadWorkflow('ci.yml');
  const jobs = ci.jobs;
  assert.deepEqual(Object.keys(jobs).sort(), ['host-acceptance', 'package', 'test']);

  // Unit tests across the declared engine range.
  assert.deepEqual(jobs.test.strategy.matrix.node, ['22.19.0', '24.x']);
  assert.ok(stepNames(jobs.test).includes('Unit tests'));
  assert.ok(jobs.test.steps.some((step) => step.run === 'npm test'));
  assert.ok(jobs.test.steps.some((step) => step.run === 'npm ci --ignore-scripts'));

  // Packaging: reproducible, clean, pinned, and the doctor must start with no host.
  const packageRuns = jobs.package.steps.map((step) => step.run).filter(Boolean).join('\n');
  assert.match(packageRuns, /npm run pack:check/);
  assert.match(packageRuns, /npm run release:verify/);
  assert.match(packageRuns, /npm run release:pack/);
  assert.match(packageRuns, /verify-artifact\.mjs .*--content-only/);
  assert.match(packageRuns, /sha256sum --check SHA256SUMS/);
  assert.match(packageRuns, /doctor\.mjs/);
  assert.match(packageRuns, /release\/manifest\.json/, 'the published tarball must be selected by the release pin');

  // Real host acceptance for exactly the declared supported versions.
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = manifest.peerDependencies['@deepseek-ai/dsh'].split('||').map((value) => value.trim());
  assert.deepEqual([...jobs['host-acceptance'].strategy.matrix.host].sort(), [...declared].sort());
  assert.ok(jobs['host-acceptance'].steps.some((step) => String(step.run).includes('run-host-acceptance.mjs')));
  assert.deepEqual(jobs['host-acceptance'].needs, ['package']);
});

test('CI clean install and upload select only the pinned candidate when historical tarballs coexist', () => {
  const steps = loadWorkflow('ci.yml').jobs.package.steps;
  const pin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'release', 'manifest.json'), 'utf8'));
  const resolve = steps.find((step) => step.id === 'pinned-artifact');
  const doctor = steps.find((step) => String(step.run).includes('doctor.mjs'));
  const upload = steps.find((step) => String(step.uses).startsWith('actions/upload-artifact@'));
  const reference = '${{ steps.pinned-artifact.outputs.tarball }}';
  assert.equal(doctor.env.TARBALL, reference);
  assert.deepEqual(upload.with.path.trim().split('\n'), [reference, 'release/SHA256SUMS', 'release/manifest.json', 'dist/manifest.json']);
  assert.equal(upload.with['if-no-files-found'], 'error');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ci-pin-'));
  try {
    // Add an invalid historical candidate to a fixture checkout: selection
    // must ignore it rather than unpack it or pass multiple paths to tar.
    fs.cpSync(path.join(repoRoot, 'release'), path.join(scratch, 'release'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'release', 'historical-candidate.tgz'), 'not an archive');
    fs.cpSync(path.join(repoRoot, 'scripts', 'release'), path.join(scratch, 'scripts', 'release'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(scratch, 'package.json'));
    const output = path.join(scratch, 'github-output');
    execFileSync('bash', ['-c', resolve.run], { cwd: scratch, env: { ...process.env, GITHUB_OUTPUT: output } });
    const selected = fs.readFileSync(output, 'utf8').trim();
    assert.equal(selected, `tarball=release/${pin.filename}`);
    const run = doctor.run.replaceAll('/tmp/clean-', `${scratch}/clean-`);
    execFileSync('bash', ['-c', run], { cwd: scratch, env: { ...process.env, TARBALL: selected.slice('tarball='.length) } });
    const installed = JSON.parse(fs.readFileSync(path.join(scratch, 'clean-install', 'package', 'package.json'), 'utf8'));
    assert.equal(installed.version, pin.version);
    assert.equal(fs.existsSync(path.join(scratch, 'clean-install', 'package', 'node_modules')), false);
    const report = JSON.parse(fs.readFileSync(path.join(scratch, 'clean-report.json'), 'utf8'));
    assert.equal(report.checks.some((check) => check.level === 'blocked'), false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the release workflow only publishes a draft of the verified artifact, never to npm', () => {
  const release = loadWorkflow('release.yml');
  const runs = releaseWorkflowRuns();
  assert.match(runs, /gh release create "\$tag" --draft/);
  // A pre-release tag must produce a pre-release, so an RC can never become
  // the repository's "latest" release.
  assert.match(runs, /--prerelease/);
  // The released bytes are the committed ones, verified — never a fresh build,
  // because npm's compression differs between npm versions.
  assert.match(runs, /npm run release:verify/);
  assert.match(runs, /gh release upload "\$tag" release\/dsh-evolution-\*\.tgz/);
  assert.equal(/npm run release:pack/.test(runs), false, 'the release workflow must not rebuild the published artifact');
  const serialized = JSON.stringify(release);
  for (const forbidden of ['npm publish', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', '--provenance']) {
    assert.equal(serialized.includes(forbidden), false, `the release workflow must not contain ${forbidden}`);
  }
  assert.deepEqual(release.permissions, { contents: 'write' });
});

test('the release workflow cannot overwrite an existing release asset', () => {
  const release = loadWorkflow('release.yml');
  const runs = releaseWorkflowRuns();
  // `--clobber` on an upload is exactly the silent replacement this forbids.
  for (const line of runs.split('\n')) {
    if (!line.includes('gh release upload')) continue;
    assert.equal(line.includes('--clobber'), false, `the upload must not clobber: ${line.trim()}`);
  }
  assert.match(runs, /refusing to overwrite/, 'the workflow must refuse an already-populated release');
  assert.match(runs, /gh release view "\$tag" --json assets/, 'the release guard must inspect the existing assets');
  // Both the guard and the upload only run for a real publish, never a dry run.
  const dryRunGuards = release.jobs.release.steps.filter((step) => /dry_run != 'true'/.test(String(step.if)));
  assert.ok(dryRunGuards.length >= 3, 'guard, create/upload and post-upload verification must be skipped on a dry run');
});

test('the release workflow verifies the tag, the commit, the pin and the checksums', () => {
  const release = loadWorkflow('release.yml');
  const runs = releaseWorkflowRuns();
  assert.match(runs, /verify-provenance\.mjs --tag "\$\{\{ steps\.tag\.outputs\.tag \}\}"/);
  assert.match(JSON.stringify(release), /--require-source-commit/);
  assert.match(runs, /npm run pack:check/);
  assert.match(runs, /npm run release:verify/);
  assert.match(runs, /sha256sum --check SHA256SUMS/);
  // The bytes GitHub ends up serving are downloaded back and re-verified.
  assert.match(runs, /gh release download "\$tag"/);
  assert.match(runs, /verify-artifact\.mjs \/tmp\/uploaded\//);
  assert.match(runs, /diff -u release\/SHA256SUMS/);
  // The provenance check walks history, so the checkout cannot be shallow.
  const checkout = release.jobs.release.steps.find((step) => String(step.uses).startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
});

test('code scanning runs CodeQL against main and pull requests', () => {
  const codeql = loadWorkflow('codeql.yml');
  const analyze = codeql.jobs.analyze;
  assert.ok(analyze, 'codeql.yml must declare an analyze job');
  assert.equal(analyze.permissions['security-events'], 'write');
  assert.deepEqual(analyze.strategy.matrix.language, ['javascript-typescript']);
  const uses = usedActions(codeql);
  assert.ok(uses.some((ref) => ref.startsWith('github/codeql-action/init@')), 'codeql.yml must initialize CodeQL');
  assert.ok(uses.some((ref) => ref.startsWith('github/codeql-action/analyze@')), 'codeql.yml must analyze');
  assert.ok(codeql.on.push, 'code scanning must run on main');
  assert.ok(codeql.on.pull_request, 'code scanning must run on pull requests');
});

test('every action runs on the Node.js 24 runtime', () => {
  // The Node.js 20 action runtime is deprecated; a `@v4`-or-older checkout,
  // setup-node, upload-artifact, pnpm/action-setup or CodeQL action would
  // reintroduce the runner warning this repository just removed.
  const node20 = /action-setup@v[1-4]$|^(actions\/(checkout|setup-node|upload-artifact)@v[1-4]|github\/codeql-action\/(init|analyze)@v[1-3])$/;
  for (const name of fs.readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    for (const uses of usedActions(loadWorkflow(name))) {
      assert.equal(node20.test(uses), false, `${name} still uses a Node.js 20 action runtime: ${uses}`);
    }
  }
});

test('the workflows pin the current supported action majors', () => {
  const expected = {
    'ci.yml': ['actions/checkout@v7', 'actions/setup-node@v7', 'actions/upload-artifact@v7', 'pnpm/action-setup@v6'],
    'release.yml': ['actions/checkout@v7', 'actions/setup-node@v7'],
    'codeql.yml': ['actions/checkout@v7', 'github/codeql-action/init@v4', 'github/codeql-action/analyze@v4'],
  };
  for (const [name, refs] of Object.entries(expected)) {
    assert.deepEqual([...new Set(usedActions(loadWorkflow(name)))].sort(), [...refs].sort(), `${name} action pins changed`);
  }
});

test('no workflow runs on pull_request_target or with write permissions by default', () => {
  for (const name of fs.readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = loadWorkflow(name);
    assert.equal(Boolean(workflow.on?.pull_request_target), false, `${name} must not use pull_request_target`);
    const serialized = JSON.stringify(workflow);
    assert.equal(serialized.includes('permissions: write-all'), false, `${name} must not request write-all`);
  }
});
