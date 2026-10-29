import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';
import { eventLogCheckpointPath, readEventLogCheckpoint } from '../../lib/event-log-checkpoint.js';

// Every fixture uses synthetic events, an explicit key and an isolated root.
// Builtin/prototype probes are restored before cleanup and tests run serially.
const KEY = 'b'.repeat(64);
const AT = '2026-10-29T00:00:00.000Z';
const ACTIVE = 'state.json.experiments-archive.jsonl';
const INDEX = 'state.json.evolution-archive-index.json';
const BATCH_FAILURE = { code: 'E_DOMAIN_ARCHIVE_BATCH_WRITE' };
const authority = { assertMutation() {} };
const measurement = (id, type = 'measurement-completed', extra = {}) => ({
  schema: 1, eventId: `evolution:${type}:${id}`, eventType: type, experimentId: id,
  proposalId: `proposal:${id}`, target: 'plugin:archive-batch', capability: 'plugin:archive-batch',
  lineageId: 'plugin:archive-batch', measurement: { latency: 12, throughput: 8 },
  audit: { at: AT }, ...extra,
});
const measurements = (count, prefix = 'row') => Array.from({ length: count }, (_, i) => measurement(`${prefix}-${i}`));
const rowId = id => `bridge:experiment:${id}`;
const isStagedActive = file => String(file).includes(`${path.sep}domain-staging${path.sep}`) && String(file).endsWith(ACTIVE);
const read = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const sha = value => createHash('sha256').update(value).digest('hex');
const treeDigests = root => Object.fromEntries(Object.entries(archiveTree(root)).map(([name, bytes]) => [name, sha(bytes)]));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-archive-batch-'));
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: KEY };
  const f = { root, backend, ctx, config, port: null, sequence: 0,
    live: path.join(root, 'dockyard'), durable: path.join(root, 'official', 'evolution_domain.json') };
  f.open = async () => { f.port = await openDomainStorage(ctx, config); return f.port; };
  f.close = async (failure = null) => {
    const port = f.port; f.port = null;
    if (!port) return;
    if (failure) await assert.rejects(port.close(), failure);
    else await port.close();
  };
  f.append = inputs => {
    const envelopes = inputs.map(event => signEventBridgeEnvelope(event, { key: KEY, sequence: ++f.sequence }));
    fs.appendFileSync(config.eventBridgePath, envelopes.map(value => JSON.stringify(value)).join('\n') + '\n');
    return envelopes;
  };
  f.document = () => fs.existsSync(f.durable) ? JSON.parse(fs.readFileSync(f.durable, 'utf8')).global
    : { applied: {}, pending: null, aggregate: {} };
  t.after(async () => {
    try { await f.close(); }
    finally { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  return f;
}

function archiveTree(root) {
  const files = {};
  const walk = (directory, relative = '') => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), name);
      else if (entry.isFile()) files[name] = fs.readFileSync(path.join(directory, entry.name));
    }
  };
  walk(root);
  return files;
}
function archiveRows(root) {
  const tree = archiveTree(root);
  const segments = Object.keys(tree).filter(file => file.startsWith(`${ACTIVE}.segments/segment-`)).sort();
  const files = [...segments, ACTIVE].filter(file => tree[file]);
  return files.flatMap(file => tree[file].toString('utf8').split('\n').filter(Boolean).map(JSON.parse));
}
function normalizedDocument(f) {
  // Only transaction roots differ: both sides still use the same durable schema
  // and byte-comparable index/JSONL files. No payload/timestamp field is masked.
  return JSON.parse(JSON.stringify(f.document()).split(f.root).join('<root>')
    .replace(/stage-[0-9a-f-]{36}/g, 'stage-<uuid>'));
}
async function frozen(run) {
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate { constructor(...values) { super(...(values.length ? values : [AT])); } };
  try { return await run(); } finally { globalThis.Date = RealDate; }
}
async function patch(object, name, replacement, run) {
  const original = object[name];
  object[name] = replacement(original);
  syncBuiltinESMExports();
  try { return await run(); }
  finally { object[name] = original; syncBuiltinESMExports(); }
}
async function memoryOptions(options, run) {
  return patch(EvolutionMemory.prototype, 'applyExecutionEvents', original => async function (inputs) {
    Object.assign(this, options);
    return original.call(this, inputs);
  }, run);
}
async function countArchiveWrites(run) {
  const counts = { appends: 0, tails: 0, payloadBytes: [], rowCounts: [] };
  const append = fsp.appendFile, open = fs.openSync;
  fsp.appendFile = async function (file, payload, ...options) {
    if (isStagedActive(file)) {
      counts.appends += 1;
      counts.payloadBytes.push(Buffer.byteLength(payload));
      counts.rowCounts.push(String(payload).split('\n').filter(Boolean).length);
    }
    return append.call(this, file, payload, ...options);
  };
  fs.openSync = function (file, ...options) {
    if (isStagedActive(file) && new Error().stack.includes('#activeTailIsTorn')) counts.tails += 1;
    return open.call(this, file, ...options);
  };
  syncBuiltinESMExports();
  try { await run(counts); return counts; }
  finally { fsp.appendFile = append; fs.openSync = open; syncBuiltinESMExports(); }
}

test('official replay batches 520 evictions into 256/256/8 writes and drains before publication', async t => {
  const f = await fixture(t);
  await f.open();
  const inputs = measurements(570);
  f.append(inputs);
  const counts = await countArchiveWrites(async () => assert.deepEqual(await f.port.flush(), { applied: 570, duplicates: 0 }));
  assert.equal(counts.appends, 3);
  assert.deepEqual(counts.rowCounts, [256, 256, 8]);
  assert.equal(counts.tails, 2, 'only nonempty physical append boundaries probe the existing tail');
  assert.deepEqual(archiveRows(f.live).map(row => row.id), inputs.slice(0, 520).map(event => rowId(event.experimentId)));
  const document = f.document();
  assert.equal(document.pending, null);
  assert.equal(Object.keys(document.applied).length, 570);
  assert.deepEqual(document.aggregate.evolution.experiments.map(row => row.id), inputs.slice(-50).map(event => rowId(event.experimentId)));
  assert.equal(document.aggregate.evolution.coldArchives.experiments.count, 520);
  const index = JSON.parse(fs.readFileSync(path.join(f.live, INDEX), 'utf8'));
  const active = index.segments.find(entry => entry.collection === 'experiments' && !entry.sealed);
  assert.equal(active.physicalCount, 520);
  assert.equal(active.byteSize, fs.statSync(path.join(f.live, ACTIVE)).size);
  const before = archiveTree(f.live);
  assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 570 });
  await f.close(); await f.open();
  assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 570 });
  assert.deepEqual(archiveTree(f.live), before, 'no-op replay/restart preserves all archive/index bytes');
});

test('the UTF-8 byte threshold drains a measurement run before its 256-row limit', async t => {
  const f = await fixture(t); await f.open();
  const metrics = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`metric${String(i).padStart(3, '0')}${'x'.repeat(30)}`, i]));
  f.append(measurements(130, 'byte').map(event => ({ ...event, measurement: metrics })));
  const counts = await countArchiveWrites(async () => assert.equal((await f.port.flush()).applied, 130));
  assert.ok(counts.appends >= 2, 'the 80 evictions must cross the byte cap without reaching 256 rows');
  assert.ok(counts.rowCounts.every(count => count < 256));
  assert.equal(counts.rowCounts.reduce((sum, count) => sum + count, 0), 80);
  assert.equal(archiveRows(f.live).length, 80);
});

test('ordinary transactional Memory does not enable archive batching', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-archive-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let aggregate = { evolution: { schema: 4 } };
  const stateStore = { filePath: path.join(root, 'state.json'), inlineSerialization: true,
    load: async () => aggregate, update: async updater => { aggregate = updater(aggregate); } };
  const memory = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority });
  await memory.load({ snapshot: false });
  let appends = 0;
  await patch(fsp, 'appendFile', original => async function (file, ...args) {
    if (String(file).endsWith(ACTIVE)) appends += 1;
    return original.call(this, file, ...args);
  }, async () => assert.deepEqual(await memory.applyExecutionEvents(measurements(60)), { duplicates: 0 }));
  assert.equal(appends, 10, 'a transaction alone is not proof of a private staged replay');
  assert.equal(archiveRows(root).length, 10);
  assert.equal(memory.snapshot().experiments.length, 50);
});

test('eager and batched replay produce identical JSONL, segments, index and durable state', async t => frozen(async () => {
  const eager = await fixture(t), batched = await fixture(t);
  const inputs = measurements(590, 'equivalent');
  // Small targets exercise exact segment boundaries, including a row larger
  // than the target, without a large or slow test fixture.
  inputs[95].measurement = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`metric${i}`, i]));
  const run = async (f, batch) => {
    await f.open(); f.append(inputs);
    await patch(EvolutionMemory.prototype, 'applyExecutionEvents', original => async function (events) {
      this.archiveMaxBytes = 1024;
      if (batch) return original.call(this, events);
      let duplicates = 0;
      for (const event of events) if ((await this.applyExecutionEvent(event)).duplicate) duplicates += 1;
      return { duplicates };
    }, async () => { await f.port.flush(); });
    return { document: sha(JSON.stringify(normalizedDocument(f))), tree: treeDigests(f.live), query: f.port.query('experiments', 100) };
  };
  const a = await run(eager, false), b = await run(batched, true);
  assert.ok(Object.keys(b.tree).filter(file => file.includes('.segments/segment-')).length > 5);
  assert.deepEqual(b, a);
}));

test('hot, pending and cold experiment id reuse across event types in one batch preserves replacements', async t => frozen(async () => {
  const eager = await fixture(t), batched = await fixture(t);
  const seed = measurements(60, 'seed').map(event => measurement(event.experimentId, 'trial-completed'));
  const inputs = [...measurements(8, 'before-hot'), measurement('seed-59'),
    ...measurements(8, 'before-pending'), measurement('seed-18'),
    ...measurements(8, 'before-cold'), measurement('seed-0'),
    ...measurements(8, 'before-other'), measurement('failure', 'failure-learned', { failureFingerprint: 'synthetic-negative', failure: { code: 'SYNTHETIC' } }),
    ...measurements(8, 'after-other')];
  const run = async (f, batch) => {
    await f.open(); f.append([...seed, ...inputs]);
    if (batch) await f.port.flush();
    else await patch(EvolutionMemory.prototype, 'applyExecutionEvents', () => async function (events) {
      let duplicates = 0;
      for (const event of events) if ((await this.applyExecutionEvent(event)).duplicate) duplicates += 1;
      return { duplicates };
    }, async () => { await f.port.flush(); });
    return { document: sha(JSON.stringify(normalizedDocument(f))), tree: treeDigests(f.live), query: f.port.query('experiments', 200) };
  };
  const a = await run(eager, false), b = await run(batched, true);
  assert.deepEqual(b, a, 'all replacement and mixed-event barriers preserve the eager output');
  const rows = [...archiveRows(batched.live), ...batched.document().aggregate.evolution.experiments];
  for (const id of ['seed-59', 'seed-18', 'seed-0']) assert.equal(rows.filter(row => row.id === rowId(id)).at(-1).status, 'measured');
  assert.ok(batched.document().aggregate.evolution.knowledge.length > 0, 'the mixed failure must really exercise knowledge');
}));

test('a knowledge-bearing experiment drains before its archive lookup inside a batch', async t => {
  const f = await fixture(t); await f.open();
  const record = EvolutionMemory.prototype.recordExperiment;
  let witnessed = false;
  await patch(EvolutionMemory.prototype, 'recordExperiment', () => async function (value) {
    if (value.experimentId !== 'knowledge-boundary') return record.call(this, value);
    // Inject a semantic row at the existing internal record boundary: the
    // projected measurement DTO normally has no semantic dimensions. This
    // exercises #append's separate knowledge guard rather than the outer
    // non-measurement guard, which the mixed-event integration test covers.
    const result = await record.call(this, { ...value, issueType: 'synthetic-failure', semanticFact: 'batch barrier' });
    assert.ok(archiveRows(path.dirname(this.stateStore.filePath)).some(row => row.id === rowId('knowledge-0')));
    witnessed = true;
    return result;
  }, async () => {
    f.append([...measurements(60, 'knowledge'), measurement('knowledge-boundary')]);
    assert.equal((await f.port.flush()).applied, 61);
  });
  assert.equal(witnessed, true);
  assert.ok(f.document().aggregate.evolution.knowledge.length > 0);
});

async function seed(f, count = 60) {
  await f.open(); f.append(measurements(count, 'committed')); await f.port.flush();
}
async function failedFlush(f, inject, run = () => f.port.flush()) {
  const before = { document: read(f.durable), tree: archiveTree(f.live), checkpoint: read(eventLogCheckpointPath(f.root)) };
  let injected = false;
  await inject(() => { injected = true; }, async () => {
    await assert.rejects(run(), BATCH_FAILURE);
    assert.equal(injected, true, 'the requested filesystem failure must be reached');
    assert.deepEqual(read(f.durable), before.document, 'no aggregate, pending record or marker may be published');
    assert.deepEqual(archiveTree(f.live), before.tree, 'the live archive tree must remain byte-identical');
    assert.deepEqual(read(eventLogCheckpointPath(f.root)), before.checkpoint, 'a failed batch must not advance replay coverage');
  });
  await f.close(BATCH_FAILURE);
}

test('a partial staged append aborts publication and a fresh replay applies every row once', async t => {
  const f = await fixture(t); await seed(f);
  f.append(measurements(75, 'partial'));
  let prefix = null;
  await failedFlush(f, (mark, run) => patch(fsp, 'appendFile', original => async function (file, payload, ...options) {
    if (isStagedActive(file)) {
      mark();
      prefix = Buffer.from(payload).subarray(0, 37);
      await original.call(this, file, prefix, ...options);
      throw Object.assign(new Error('synthetic partial append'), { code: 'EIO' });
    }
    return original.call(this, file, payload, ...options);
  }, run));
  const stages = fs.readdirSync(path.join(f.root, 'domain-staging')).map(stage => path.join(f.root, 'domain-staging', stage, ACTIVE));
  assert.ok(stages.some(file => read(file)?.subarray(-prefix.length).equals(prefix)),
    'the fault must leave its real partial bytes in an unpublished stage');
  await f.open();
  assert.equal(f.port.query('experiments', 200).count, 135);
  assert.equal(Object.keys(f.document().applied).length, 135);
  assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 135 });
  assert.equal(archiveRows(f.live).length, 85);
});

for (const tail of ['incomplete', 'complete-without-newline']) {
  test(`batch append preserves an inherited ${tail} tail before writing new rows`, async t => {
    const f = await fixture(t); await seed(f);
    const active = path.join(f.live, ACTIVE);
    const fragment = Buffer.from('{"id":"uncommitted-fragment","payload":"\u4e2d');
    if (tail === 'incomplete') fs.appendFileSync(active, fragment);
    else fs.truncateSync(active, fs.statSync(active).size - 1);
    f.append(measurements(10, 'after-tail'));
    assert.equal((await f.port.flush()).applied, 10);
    assert.equal(f.port.query('experiments', 200).count, 70);
    const quarantines = Object.entries(archiveTree(f.live)).filter(([name]) => name.includes('quarantine-archive.jsonl'));
    if (tail === 'incomplete') {
      assert.equal(quarantines.length, 1);
      assert.deepEqual(quarantines[0][1], Buffer.concat([fragment, Buffer.from('\n')]));
    } else assert.equal(quarantines.length, 0, 'a complete JSON record only needs its separator');
    assert.equal(archiveRows(f.live).length, 20);
    await f.close(); await f.open();
    assert.equal(f.port.query('experiments', 200).count, 70);
    assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 70 });
  });
}

test('quarantine append failure preserves the original broken live tail and refuses the batch', async t => {
  const f = await fixture(t); await seed(f);
  const fragment = Buffer.from('{"synthetic":"torn');
  fs.appendFileSync(path.join(f.live, ACTIVE), fragment);
  f.append(measurements(10, 'quarantine-retry'));
  await failedFlush(f, (mark, run) => patch(fsp, 'appendFile', original => async function (file, ...args) {
    if (String(file).includes('domain-staging') && String(file).includes('quarantine-archive.jsonl')) {
      mark(); throw Object.assign(new Error('synthetic quarantine failure'), { code: 'EIO' });
    }
    return original.call(this, file, ...args);
  }, run));
  assert.ok(read(path.join(f.live, ACTIVE)).subarray(-fragment.length).equals(fragment));
  await f.open();
  assert.equal(f.port.query('experiments', 200).count, 70);
  assert.equal(archiveRows(f.live).length, 20);
});

for (const point of ['segment-write', 'segment-rename', 'active-clear']) {
  test(`seal ${point} failure aborts the whole batch before any live publication`, async t => {
    const f = await fixture(t); await seed(f, 50);
    f.append(measurements(16, `seal-${point}`));
    await memoryOptions({ archiveMaxBytes: 1024 }, async () => {
      await failedFlush(f, (mark, run) => {
        const method = point === 'segment-rename' ? 'rename' : 'writeFile';
        return patch(fsp, method, original => async function (file, body, ...options) {
          const staged = String(file).includes('domain-staging');
          const hit = point === 'segment-write' ? /\.segments[/\\]\.segment-.*\.tmp$/.test(String(file))
            : point === 'segment-rename' ? /\.segments[/\\]segment-[0-9]+\.jsonl$/.test(String(body))
              : isStagedActive(file) && body === '';
          if (staged && hit) { mark(); throw Object.assign(new Error(`synthetic ${point}`), { code: 'EIO' }); }
          return original.call(this, file, body, ...options);
        }, run);
      });
    });
    await f.open();
    assert.equal(f.port.query('experiments', 200).count, 66);
    assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 66 });
    assert.equal(archiveRows(f.live).length, 16);
  });
}

test('a rejected pending publication leaves committed bytes intact and replays the whole group', async t => {
  const f = await fixture(t); await seed(f);
  f.append(measurements(70, 'publish-retry'));
  const before = { document: read(f.durable), tree: archiveTree(f.live) };
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  let injected = false;
  await patch(domain.global, 'set', original => async value => {
    if (value.pending) { injected = true; throw new Error('SYNTHETIC_PENDING_PUBLICATION'); }
    return original(value);
  }, async () => assert.rejects(f.port.flush(), /SYNTHETIC_PENDING_PUBLICATION/));
  assert.equal(injected, true);
  assert.deepEqual(read(f.durable), before.document);
  assert.deepEqual(archiveTree(f.live), before.tree);
  assert.equal(f.document().pending, null);
  await f.close(/SYNTHETIC_PENDING_PUBLICATION/); await f.open();
  assert.equal(f.port.query('experiments', 200).count, 130);
  assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 130 });
});

test('a committed batch with failed closing write recovers without a second application', async t => {
  const f = await fixture(t); await seed(f);
  f.append(measurements(70, 'closing-retry'));
  const domain = f.ctx.storageDomain.get(evolutionDomainSpec.name);
  let injected = false;
  await patch(domain.global, 'set', original => async value => {
    if (value.pending === null && !injected) { injected = true; throw new Error('SYNTHETIC_CLOSING_WRITE'); }
    return original(value);
  }, async () => assert.rejects(f.port.flush(), /SYNTHETIC_CLOSING_WRITE/));
  const pending = f.document().pending;
  assert.ok(pending?.files.some(entry => entry.file === ACTIVE));
  assert.equal(Object.keys(pending.applied).length, 130);
  const before = archiveTree(f.live);
  let reapplied = 0;
  await patch(EvolutionMemory.prototype, 'applyExecutionEvent', original => async function (event) {
    reapplied += 1; return original.call(this, event);
  }, async () => assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 130 }));
  assert.equal(reapplied, 0, 'the committed ledger, rather than a bounded working window, owns recovered events');
  assert.equal(f.document().pending, null);
  assert.equal(f.port.query('experiments', 200).count, 130);
  assert.deepEqual(archiveTree(f.live), before);
  await f.close(/SYNTHETIC_CLOSING_WRITE/); await f.open();
  assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 130 });
});

for (const point of ['before-drain', 'after-pending']) {
test(`SIGKILL ${point} recovers the complete logged batch without lost or duplicate effects`, { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const code = `
    import fs from 'node:fs'; import path from 'node:path';
    import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
    import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
    import { openDomainStorage, evolutionDomainSpec } from './lib/domain-storage.js';
    import { EvolutionMemory } from './lib/dockyard-domain/memory.js';
    import { signEventBridgeEnvelope } from './lib/orchestrator.js';
    const root = process.argv[1], key = 'b'.repeat(64);
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
      storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: key };
    const port = await openDomainStorage(ctx, config);
    const domain = ctx.storageDomain.get(evolutionDomainSpec.name), set = domain.global.set;
    domain.global.set = async value => {
      const result = await set(value);
      if ('${point}' === 'after-pending' && value.pending) {
        process.send({ pending: true, files: value.pending.files.length }); await new Promise(() => {});
      }
      return result;
    };
    if ('${point}' === 'before-drain') {
      let applied = 0;
      const original = EvolutionMemory.prototype.applyExecutionEvent;
      EvolutionMemory.prototype.applyExecutionEvent = async function (event) {
        const result = await original.call(this, event);
        if (++applied === 60) {
          process.send({ buffered: true, hot: this.snapshot().experiments.length }); await new Promise(() => {});
        }
        return result;
      };
    }
    const events = Array.from({ length: 80 }, (_, i) => {
      const id = 'killed-' + i;
      return signEventBridgeEnvelope({ schema: 1, eventId: 'evolution:measurement-completed:' + id,
        eventType: 'measurement-completed', experimentId: id, target: 'plugin:kill-batch',
        measurement: { latency: i }, audit: { at: '${AT}' } }, { key, sequence: i + 1 });
    });
    fs.writeFileSync(config.eventBridgePath, events.map(event => JSON.stringify(event)).join('\\n') + '\\n');
    process.on('message', () => {});
    await port.flush();
  `;
  const child = spawn(process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', code, f.root],
    { cwd: path.resolve(import.meta.dirname, '../..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`pending publication timed out: ${stderr}`)); }, 15000);
    const onMessage = value => { cleanup(); resolve(value); };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`child exited ${code}/${signal}: ${stderr}`)); };
    function cleanup() { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); }
    child.once('message', onMessage); child.once('exit', onExit);
  });
  if (point === 'after-pending') {
    assert.ok(message.pending && message.files > 0);
    assert.ok(f.document().pending);
  } else {
    assert.equal(message.buffered, true);
    assert.equal(message.hot, 50, 'ten records have left the hot window but remain only in the private batch');
    assert.equal(f.document().pending, null);
    assert.equal(Object.keys(f.document().applied).length, 0);
    assert.equal(fs.existsSync(f.durable), false, 'the buffered window has not published a domain document');
    const staging = path.join(f.root, 'domain-staging');
    assert.ok(fs.readdirSync(staging).every(stage => !fs.existsSync(path.join(staging, stage, ACTIVE))),
      'the ten evicted rows must still be in memory, not appended to any stage');
  }
  assert.equal(fs.existsSync(path.join(f.live, ACTIVE)), false, 'the child stopped before installation');
  const exited = once(child, 'exit'); child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  await f.open();
  assert.equal(f.document().pending, null);
  assert.equal(Object.keys(f.document().applied).length, 80);
  const markers = f.document().aggregate.evolution.eventBridge.applied;
  assert.equal(markers.length, 80);
  assert.equal(new Set(markers.map(marker => marker.eventId)).size, 80);
  assert.equal(f.port.query('experiments', 200).count, 80);
  assert.deepEqual(archiveRows(f.live).map(row => row.id), Array.from({ length: 30 }, (_, i) => rowId(`killed-${i}`)));
  assert.deepEqual(f.document().aggregate.evolution.experiments.map(row => row.id), Array.from({ length: 50 }, (_, i) => rowId(`killed-${i + 30}`)));
  assert.deepEqual(await f.port.flush(), { applied: 0, duplicates: 80 });
  assert.equal(readEventLogCheckpoint(eventLogCheckpointPath(f.root)).records, 80);
});
}
