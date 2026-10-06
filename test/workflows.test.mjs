/**
 * The GitHub workflows are part of the release contract: a syntax error in one
 * of them means the repository has no working CI, and GitHub only reports that
 * when the workflow is next triggered. Parse them here instead, and assert the
 * properties the release process depends on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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

  // Packaging: reproducible, clean, and the doctor must start with no host.
  const packageRuns = jobs.package.steps.map((step) => step.run).filter(Boolean).join('\n');
  assert.match(packageRuns, /npm run pack:check/);
  assert.match(packageRuns, /npm run release:pack/);
  assert.match(packageRuns, /sha256sum --check SHA256SUMS/);
  assert.match(packageRuns, /doctor\.mjs/);

  // Real host acceptance for exactly the declared supported versions.
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = manifest.peerDependencies['@deepseek-ai/dsh'].split('||').map((value) => value.trim());
  assert.deepEqual([...jobs['host-acceptance'].strategy.matrix.host].sort(), [...declared].sort());
  assert.ok(jobs['host-acceptance'].steps.some((step) => String(step.run).includes('run-host-acceptance.mjs')));
  assert.deepEqual(jobs['host-acceptance'].needs, ['package']);
});

test('the release workflow only publishes a draft, never to npm', () => {
  const release = loadWorkflow('release.yml');
  const runs = release.jobs.release.steps.map((step) => step.run).filter(Boolean).join('\n');
  assert.match(runs, /gh release create "\$tag" --draft/);
  const serialized = JSON.stringify(release);
  for (const forbidden of ['npm publish', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', '--provenance']) {
    assert.equal(serialized.includes(forbidden), false, `the release workflow must not contain ${forbidden}`);
  }
  assert.deepEqual(release.permissions, { contents: 'write' });
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
