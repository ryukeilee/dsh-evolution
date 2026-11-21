// The lightweight cross-entry experience collector must not reach the kernel.
//
// `dsh-evolution/experience` and `dsh-evolution/experience-history` are enabled
// in ACP and Web profiles, where the orchestrator row is disabled. They used to
// import `safeErrorDto` from orchestrator.js, `resolveEvolutionPaths` from
// diagnostics.js and the two logging wrappers from registration.js, so every
// session parsed and instantiated the whole kernel/doctor graph for three small
// helpers (measured in docs/performance/experience-entry-load-20261117.md).
// The shared boundary now lives in error-boundary.js, the path resolver in
// evolution-paths.js, and this test pins the resulting closure so the kernel
// cannot reappear through an innocent-looking import.
//
// It is a source-graph test, not a runtime one: importing the kernel succeeds
// either way, so only the import edges can tell the two graphs apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..' + path.sep + 'lib';
const LIB_ROOT = path.resolve(LIB);

function specifiersOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(/(?:from\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) found.add(match[1]);
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) found.add(match[1]);
  return [...found];
}

function closureOf(entry) {
  const visited = new Set();
  const queue = [path.resolve(LIB_ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of specifiersOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(resolved)) throw new Error(`unresolved import ${specifier} from ${path.relative(LIB_ROOT, file)}`);
      queue.push(resolved);
    }
  }
  return [...visited].map((file) => path.relative(LIB_ROOT, file)).sort();
}

test('the experience collector closure is the shared store and the boundary only', () => {
  assert.deepEqual(closureOf('experience-collector.js'), [
    'dockyard-domain/knowledge.js',
    'error-boundary.js',
    'evolution-paths.js',
    'experience-collector.js',
    'experience-plan.js',
    'experience-recall.js',
    'shared-experience.js',
    'verification-call.js',
  ]);
});

test('the history entry closure is the collector closure plus its own entry', () => {
  const collector = closureOf('experience-collector.js');
  assert.deepEqual(closureOf('experience-history.js'), [...collector, 'experience-history.js'].sort());
});

test('no kernel or doctor module is reachable from the lightweight entries', () => {
  const reachable = new Set([...closureOf('experience-collector.js'), ...closureOf('experience-history.js')]);
  for (const forbidden of [
    'index.js',
    'orchestrator.js',
    'diagnostics.js',
    'registration.js',
    'domain-storage.js',
    'archive-stage.js',
    'event-log-checkpoint.js',
    'cordis-compat.js',
    'guard.js',
    'promoted-sharing.js',
    'promoted-consumer.js',
    'promotion-include.js',
    'self-evolution-review.js',
    'runtime-versions.js',
    'shared-experience-migration.js',
    'compat/legacy-startup-drift.js',
  ]) {
    assert.equal(reachable.has(forbidden), false, `${forbidden} is reachable from the lightweight experience entries`);
  }
});

test('both entries still load and export their plugin surface', async () => {
  for (const entry of ['experience-collector.js', 'experience-history.js']) {
    const module = await import(pathToFileURL(path.join(LIB_ROOT, entry)).href);
    assert.equal(typeof module.apply, 'function', `${entry} has no apply() export`);
  }
});
