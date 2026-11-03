// Real official storage and registered listener, alternating pinned-main / working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
const repo = path.resolve(import.meta.dirname, '../..');
const source = '9d91dc9';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-restart-ab-'));
fs.mkdirSync(path.join(temp, 'baseline'));
execFileSync('tar', ['-x', '-C', path.join(temp, 'baseline')], { input: execFileSync('git', ['archive', source, 'lib'], { cwd: repo, maxBuffer: 16 * 1024 * 1024 }) });
fs.writeFileSync(path.join(temp, 'baseline/package.json'), '{"type":"module"}');
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(temp, 'baseline/node_modules'));
const implementations = {};
for (const [name, root] of [['before', path.join(temp, 'baseline')], ['after', repo]]) {
  implementations[name] = { ...await import(pathToFileURL(path.join(root, 'lib/registration.js'))),
    ...await import(pathToFileURL(path.join(root, 'lib/domain-storage.js'))) };
}
const bytes = root => fs.readdirSync(root, { withFileTypes: true }).reduce((n, entry) => n + (entry.isDirectory() ? bytes(path.join(root, entry.name)) : fs.statSync(path.join(root, entry.name)).size), 0);
async function run(name, round) {
  const root = path.join(temp, `${name}-${round}`); fs.mkdirSync(root);
  const implementation = implementations[name];
  const results = []; let commits = 0;
  const start = performance.now();
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
  for (const count of [2, 1]) {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const listeners = new Map();
    const ctx = { emit() {}, effect() {}, logger: { warn() {} }, on: (n, f) => listeners.set(n, f),
      storage: { backend: { get: () => backend } }, dynamicCordisRunner: {}, tools: { register() {} }, systemPrompt: { section() {} } };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'b'.repeat(64), startupDrift: false,
      patternThreshold: 3, autonomousStrategies: { AGENT_ERROR: { risk: 'medium', target: 'plugin:fix' } } };
    const port = await implementation.openDomainStorage(ctx, config);
    const domain = ctx.storageDomain.get('evolution_domain');
    const set = domain.global.set.bind(domain.global);
    domain.global.set = async value => { commits++; return set(value); };
    const core = implementation.apply(ctx, { ...config, domainStorage: port });
    const observe = core.observeAutonomous.bind(core);
    let settled;
    core.observeAutonomous = (...args) => { const p = observe(...args); p.then(settled.resolve, settled.reject); return p; };
    for (let index = 0; index < count; index++) {
      const p = new Promise((resolve, reject) => { settled = { resolve, reject }; });
      const error = Object.assign(new Error('provider unavailable'), { code: 'AGENT_ERROR' });
      listeners.get('agent/error')({ agent: { id: 'owner' }, error });
      const result = await p;
      results.push({ phase: result.phase, occurrences: result.occurrences ?? result.candidate?.observationIds.length });
    }
    await port.close(); await backend.close();
  }
  global.gc?.();
  return { implementation: name, round, results, commits, diskBytes: bytes(root), elapsedMs: performance.now() - start,
    retainedHeapDeltaBytes: process.memoryUsage().heapUsed - heapBefore };
}
try {
  const rows = [];
  for (let round = 0; round < 4; round++) for (const name of round % 2 ? ['after', 'before'] : ['before', 'after']) rows.push(await run(name, round));
  const report = { source, node: process.version, threshold: 3, sessions: [2, 1], rows };
  const output = process.argv[2];
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
