import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveConsumerDataRoot } from '../lib/promoted-consumer.js';
import { resolveEvolutionPaths } from '../lib/diagnostics.js';

// The consumer must not import the kernel, so it carries a local copy of the
// data-root rule. This test is the drift guard: both resolvers have to agree on
// every input shape the bundle accepts (config, environment, defaults).
test('consumer data root resolves exactly like diagnostics.resolveEvolutionPaths', () => {
  const previous = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    const cases = [
      {},
      { dshHome: '/tmp/consumer-home-a' },
      { dshHome: '/tmp/consumer-home-a/', dataRoot: undefined },
      { dataRoot: '/tmp/consumer-data-b' },
      { dshHome: '/tmp/consumer-home-c', dataRoot: 'relative/data' },
      { dshHome: '', dataRoot: '' },
      { dshHome: path.join(os.homedir(), '.dsh-other') },
    ];
    for (const input of cases) {
      assert.equal(
        resolveConsumerDataRoot(input),
        resolveEvolutionPaths(input).dataRoot,
        `data root disagreed for ${JSON.stringify(input)}`,
      );
    }

    process.env.DSH_HOME = '/tmp/consumer-env-home';
    assert.equal(resolveConsumerDataRoot({}), resolveEvolutionPaths({}).dataRoot);
    assert.equal(resolveConsumerDataRoot({}), path.resolve('/tmp/consumer-env-home/storages/evolution'));
    // An explicit data root always wins over the environment.
    assert.equal(resolveConsumerDataRoot({ dataRoot: '/tmp/consumer-explicit' }), path.resolve('/tmp/consumer-explicit'));
    // An explicit dshHome wins over the environment.
    assert.equal(resolveConsumerDataRoot({ dshHome: '/tmp/consumer-explicit-home' }), path.resolve('/tmp/consumer-explicit-home/storages/evolution'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('consumer module stays lightweight: exactly the sharing contract and the Include helper', async () => {
  const module = await import('../lib/promoted-consumer.js');
  assert.equal(module.name, 'dsh-evolution-promoted-consumer');
  assert.deepEqual(module.inject, ['tools']);
  assert.equal(typeof module.apply, 'function');
  assert.equal(typeof module.createConsumerSession, 'function');
  assert.equal(typeof module.resolveConsumerProfile, 'function');
  assert.equal(typeof module.resolveConsumerDataRoot, 'function');
  const source = await fs.readFile(new URL('../lib/promoted-consumer.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(specifiers.sort(), [
    './cordis-compat.js',
    './promoted-sharing.js',
    './promotion-include.js',
    'node:crypto',
    'node:fs/promises',
    'node:os',
    'node:path',
  ].sort());
  // The kernel entries must never be reachable from this lightweight entry.
  assert.ok(!specifiers.some((specifier) => /orchestrator|diagnostics|registration|domain-storage/.test(specifier)));
});

