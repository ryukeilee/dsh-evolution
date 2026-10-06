import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { apply, commandMutatesComposition, MUTATION_VERBS_RE } from '../lib/guard.js';
import { projectEvolutionMetric } from '../lib/dockyard-domain/metric-projection.js';

test('shell mutation matching retains irreversible, redirect and trust-root decisions', () => {
  const cases = [
    ['publish > output', true], ['publish 2>> output', true],
    ['publish &> output', true], ['publish > /dev/null', false],
    ['publish 2>&1', false], ['publish => value', false], ['publish -> value', false],
    ['publish >', false], ['publish sed -i file', true],
    ['publish perl -i.bak file', true], ['publish yq -i file', true],
    ['publish find file -delete', true], ['publish node open(file)', true],
    ['publish python3 write(file)', true], ['publish git restore file', true],
    ['publish sed \n -i file', true], ['publish perl \n write(file)', false],
    ['publish sed -i; echo ok', true], ['publish sed file\n-i', false],
    ['publish node print(file)', false], ['publish sed file', false],
    ['publish -i sed file', false], ['publish write node', false],
    ['cat node_modules/@deepseek-ai/cordis/package.json', false],
    ['cp source node_modules/@deepseek-ai/cordis/package.json', true],
    ['cp node_modules/@deepseek-ai/cordis/package.json /tmp/copy', false],
  ];
  for (const [command, expected] of cases) assert.equal(commandMutatesComposition(command), expected, command);
  assert.equal(MUTATION_VERBS_RE.test('2>> output'), true);
  assert.equal(MUTATION_VERBS_RE instanceof RegExp, true);
  assert.equal(MUTATION_VERBS_RE.flags, 'i');
  assert.equal(new RegExp(MUTATION_VERBS_RE.source, MUTATION_VERBS_RE.flags).test('sed -i file'), true);
  assert.equal(MUTATION_VERBS_RE.exec('sed -i file')[0], 'sed -i');
  assert.equal('sed -i file'.match(MUTATION_VERBS_RE)[0], 'sed -i');
  assert.equal('sed -i file'.replace(MUTATION_VERBS_RE, 'blocked'), 'blocked file');
  let guard;
  apply({ tools: { guard: (callback) => { guard = callback; } } });
  assert.match(guard({ name: 'bash', arguments: { command: 'publish > output' } }), /已被拒绝/);
  assert.equal(guard({ name: 'bash', arguments: { command: 'publish > /dev/null' } }), undefined);
  assert.match(guard({ name: 'write', arguments: { file_path: '/tmp/.env' } }), /不可逆风险/);
});

test('uncontrolled shell input cannot stall the pre-execution guard', () => {
  // A child-process deadline also catches a synchronous event-loop stall;
  // node:test timeouts alone cannot interrupt a backtracking regexp.
  const moduleUrl = new URL('../lib/guard.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { apply } from ${JSON.stringify(moduleUrl)};
    let guard;
    apply({ tools: { guard: callback => { guard = callback; } } });
    for (const tail of ['0'.repeat(1000000), ' '.repeat(1000000),
      'sed '.repeat(100000), 'perl '.repeat(100000), 'node '.repeat(100000),
      'sed ' + ' '.repeat(1000000), 'find ' + ' '.repeat(1000000)]) {
      assert.equal(guard({name: 'bash', arguments: {command: 'publish ' + tail}}), undefined);
      assert.match(guard({name: 'bash', arguments: {command: 'publish ' + tail + '> output'}}), /已被拒绝/);
    }
  `], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});

test('metric fallback identifiers use UUIDs once per record without weak randomness', (t) => {
  t.mock.method(Math, 'random', () => { throw new Error('weak randomness must not be used'); });
  const ids = new Set();
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  for (const kind of ['task', 'goal', 'agent', 'session', 'component']) {
    for (let i = 0; i < 20; i++) {
      const metric = projectEvolutionMetric(kind, { componentId: 'component-a', success: false, metrics: { latencyMs: 12 } }, { clock: () => new Date(0) });
      assert.match(metric.id, new RegExp(`^${kind}:${kind === 'component' ? 'component-a:' : ''}${uuid}$`));
      if (kind !== 'component') assert.equal(metric[`${kind}Id`], metric.id);
      assert.equal(metric.recordedAt, '1970-01-01T00:00:00.000Z');
      assert.equal(metric.latencyMs, 12);
      if (kind !== 'component') assert.equal(metric.success, false);
      assert.equal(ids.has(metric.id), false);
      ids.add(metric.id);
    }
  }
});

test('caller-provided metric identities and projection data remain unchanged', () => {
  for (const kind of ['task', 'goal', 'agent', 'session']) {
    const sample = { id: 0, [`${kind}Id`]: 'secondary', metadata: { nested: ['original'] }, metrics: { success: true, duration: 9 } };
    const metric = projectEvolutionMetric(kind, sample);
    assert.equal(metric.id, '0');
    assert.equal(metric[`${kind}Id`], '0');
    assert.equal(metric.success, true);
    assert.equal(metric.completionTimeMs, 9);
    metric.metadata.nested.push('copy');
    assert.deepEqual(sample.metadata.nested, ['original']);
    assert.equal(projectEvolutionMetric(kind, { [`${kind}Id`]: 'caller' }).id, 'caller');
  }
  assert.equal(projectEvolutionMetric('component', { componentId: 'component-a', id: 'caller', regressionPassed: false }).id, 'caller');
  assert.equal(projectEvolutionMetric('component', { componentId: 'component-a', regressionPassed: false }).stability, 0);
});
