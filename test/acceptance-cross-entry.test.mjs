/**
 * Static and CLI-shape contract for the cross-entry acceptance tooling.
 *
 * These checks protect the pieces CI shape depends on without installing a
 * host: the new flag is documented and guarded, the existing acceptance call
 * sites keep their original three-argument `bootProbe` form, the publish and
 * consumer probes share one marker vocabulary, and the local runner refuses an
 * obviously unusable invocation without writing evidence into the repository.
 *
 * The real end-to-end proof lives in the evidence JSON written by the runners
 * (docs/evidence/cross-entry-*.json); this file never claims to replace it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptance = path.join(repoRoot, 'scripts', 'acceptance');
const runHost = path.join(acceptance, 'run-host-acceptance.mjs');
const runCrossEntry = path.join(acceptance, 'run-cross-entry.mjs');
const promotionProbe = path.join(acceptance, 'probes', 'cross-entry-promotion-probe.mjs');
const consumerProbe = path.join(acceptance, 'probes', 'cross-entry-consumer-probe.mjs');

function runNode(args, env = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

test('run-host-acceptance documents --cross-entry and refuses it on older hosts', () => {
  const help = runNode([runHost, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--cross-entry/);
  assert.match(help.stdout, /0\.2\.2-rc\.1/);

  // The guard runs before any host install or evidence write.
  const refused = runNode([runHost, '--host', '0.2.1-rc.2', '--cross-entry', '--tarball', path.join(repoRoot, 'dist', 'does-not-exist.tgz')]);
  assert.equal(refused.status, 2, `${refused.stdout}${refused.stderr}`);
  assert.match(refused.stderr, /refusing to run: --cross-entry/);
});

test('existing acceptance call sites keep the original bootProbe form', () => {
  const source = fs.readFileSync(runHost, 'utf8');
  // The flag must be opt-in: the pre-existing steps call bootProbe with exactly
  // the three original arguments (name, probe file, environment).
  assert.match(source, /bootProbe\('core-1', coreFile, \{ EVOLUTION_ACCEPTANCE_CWD: work \}\)/);
  assert.match(source, /bootProbe\(`promotion-\$\{command\}`, promotionFile, \{/);
  assert.match(source, /bootProbe\(`experience-evolution-\$\{phase\}`, probeFile, \{/);
  // Extra overlay rows and alternate profiles are an additive option object.
  assert.match(source, /function bootProbe\(name, probeFile, extraEnv = \{\}, \{ profile = 'web', rows = \[\], awaitExit = false \} = \{\}\)/);
});

test('the publish and consumer probes share the marker vocabulary and the approval scope', () => {
  const publish = fs.readFileSync(promotionProbe, 'utf8');
  const consume = fs.readFileSync(consumerProbe, 'utf8');
  for (const marker of ['cross-entry/probe/stable', 'cross-entry/probe/incompatible']) {
    assert.ok(publish.includes(marker), `the publish probe does not register ${marker}`);
  }
  // The consumer probe takes the exact marker names from the runner through one
  // env contract instead of duplicating the literals, so the vocabulary cannot
  // drift between the two processes.
  assert.match(consume, /EVOLUTION_CROSS_ENTRY_MARKERS/);
  assert.match(consume, /await ctx\.parallel\(marker, payload\)/);
  assert.match(publish, /const TARGET_PROFILES = \['acp', 'web'\]/);
  assert.match(publish, /targetProfiles: TARGET_PROFILES/);
  assert.match(publish, /confirmation: true/);
  assert.match(consume, /EVOLUTION_CROSS_ENTRY_EXPECT_KERNEL/);
});

test('run-cross-entry documents its commands and refuses an unusable invocation without writing repository evidence', () => {
  const help = runNode([runCrossEntry, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--tarball/);
  assert.match(help.stdout, /release:pack/);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cross-entry-test-'));
  try {
    const out = path.join(scratch, 'evidence.json');
    const refused = runNode([
      runCrossEntry,
      '--tarball', path.join(scratch, 'missing.tgz'),
      '--work', path.join(scratch, 'work'),
      '--out', out,
    ]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /missing tarball/);
    // The failure is recorded outside the repository; no evidence file lands in
    // docs/evidence/ for a run that never started.
    const evidence = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(evidence.ok, false);
    assert.equal(evidence.kind, 'dsh-evolution-cross-entry-evidence');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
