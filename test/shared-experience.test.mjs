import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSharedExperience, experienceEventId } from '../lib/shared-experience.js';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from '../lib/dockyard-domain/knowledge.js';
import { managedPatch } from '../scripts/setup-experience.mjs';
import yaml from 'js-yaml';
import { EvolutionEventBridge } from '../lib/orchestrator.js';
import { apply as applyCore } from '../lib/registration.js';

const moduleUrl = new URL('../lib/shared-experience.js', import.meta.url).href;
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-experience-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const input = n => ({ id: experienceEventId('test', n), type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
function child(code) {
  const process = spawn(globalThis.process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; process.stderr.on('data', value => { stderr += value; });
  return { process, done: once(process, 'exit').then(([code]) => { assert.equal(code, 0, stderr); }) };
}

test('committed facts survive reopen; permanent event ledger dedups beyond canonical window', t => {
  const root = temporary(t);
  let store = openSharedExperience(root);
  for (let n = 0; n < 300; n++) store.recordFailure(input(n));
  store.close(); store = openSharedExperience(root); t.after(() => store.close());
  assert.equal(store.recordFailure(input(0)).duplicate, true);
  assert.deepEqual(store.stats(), { events: 300, knowledge: 1 });
  const row = store.recall({ problem: 'read_file' }).records[0];
  assert.equal(row.occurrences, 300);
  assert.equal(row.state, 'LEARNING');
  assert.equal(row.successCount, 0);
  assert.throws(() => store.recordFailure({ ...input(0), code: 'EACCES' }), /E_EXPERIENCE_EVENT_CONFLICT/);
  assert.equal(store.recall({ problem: 'read_file' }).records[0].occurrences, 300);
});

test('four concurrent host processes cannot overwrite facts; replay is exactly once', async t => {
  const root = temporary(t);
  const workers = Array.from({ length: 4 }, (_, worker) => child(`
    import {openSharedExperience,experienceEventId} from ${JSON.stringify(moduleUrl)};
    const s=openSharedExperience(${JSON.stringify(root)});
    for(let n=0;n<80;n++) s.recordFailure({id:experienceEventId('concurrent',${worker},n),type:'tool/error',code:'ENOENT',target:'tool:read_file'});
    s.recordFailure({id:experienceEventId('common'),code:'EACCES',target:'tool:read_file'});s.close();`));
  await Promise.all(workers.map(worker => worker.done));
  const store = openSharedExperience(root); t.after(() => store.close());
  assert.deepEqual(store.stats(), { events: 321, knowledge: 2 });
  assert.equal(store.recall({ problem: 'read_file' }).records.reduce((n, row) => n + row.occurrences, 0), 321);
});

test('SIGKILL after COMMIT retains facts; interrupted SQLite transaction rolls back on reopen', async t => {
  const root = temporary(t);
  const script = `import {openSharedExperience,experienceEventId} from ${JSON.stringify(moduleUrl)};
    import {DatabaseSync} from 'node:sqlite'; const s=openSharedExperience(${JSON.stringify(root)});
    s.recordFailure({id:experienceEventId('committed'),code:'ENOENT',target:'tool:read_file'});
    const db=new DatabaseSync(${JSON.stringify(path.join(root, 'experience.sqlite'))});
    db.exec("BEGIN IMMEDIATE; DELETE FROM events; DELETE FROM knowledge;");
    console.log('transaction-open');setInterval(()=>{},1000);`;
  const p = spawn(process.execPath, ['--max-old-space-size=4096', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(p, 'exit');
  await once(p.stdout, 'data'); p.kill('SIGKILL'); await exited;
  const store = openSharedExperience(root); t.after(() => store.close());
  assert.deepEqual(store.stats(), { events: 1, knowledge: 1 });
  assert.equal(store.recall({ problem: 'read_file' }).records[0].occurrences, 1);
});

test('only metadata is persisted; hostile text never crosses the storage boundary', t => {
  const root = temporary(t); const store = openSharedExperience(root); t.after(() => store.close());
  store.recordFailure({ ...input(1), code: 'secret: password', target: 'secret token=private', message: 'private payload', arguments: { key: 'private' } });
  store.close();
  const bytes = fs.readFileSync(path.join(root, 'experience.sqlite')).toString();
  assert.ok(!bytes.includes('private payload')); assert.ok(!bytes.includes('secret token'));
  assert.ok(!bytes.includes('secret: password'));
});

test('failure canonical output uses existing domain semantics', t => {
  const root = temporary(t); const store = openSharedExperience(root); t.after(() => store.close());
  store.recordFailure(input(1));
  const event = normalizeKnowledgeEvent({ type: 'tool/error', code: 'ENOENT', componentId: 'tool:read_file',
    severity: 'error', status: 'failed', message: 'Official operation failed (ENOENT)', eventId: input(1).id }, { sourceCollection: 'observations' });
  const baseline = mergeKnowledgeEntry(null, event);
  const actual = store.recall({ problem: 'read_file' }).records[0];
  assert.equal(actual.key, baseline.knowledgeKey); assert.equal(actual.failureCount, baseline.failureCount);
});

test('only completed Evolution promotion facts become successful knowledge', t => {
  const root = temporary(t); const store = openSharedExperience(root); t.after(() => store.close());
  assert.deepEqual(store.recordEvolution({ eventType: 'trial-completed' }, 'test'), { ignored: true });
  store.recordEvolution({ eventType: 'promotion-succeeded', target: 'tool-a', eventId: 'evolution:promotion-succeeded:exp-a' }, 'core-a');
  assert.equal(store.recall({ target: 'tool-a' }).records[0].successCount, 1);
  assert.equal(store.recall({ target: 'tool-a' }).records[0].state, 'KNOWN');
  store.recordEvolution({ eventType: 'canary-failed', target: 'tool-a', eventId: 'evolution:canary-failed:exp-a' }, 'core-a');
  const regressed = store.recall({ target: 'tool-a' }).records;
  assert.equal(regressed.length, 1);
  assert.equal(regressed[0].state, 'REGRESSED');
  assert.equal(regressed[0].regressionCount, 1);
});

test('setup is idempotent and preserves unrelated profile contents byte for byte', () => {
  const user = '- id: tstack-skills\n  config:\n    customSkillDirs: []\n';
  const next = managedPatch(user, 'acp');
  assert.ok(next.startsWith(user)); assert.equal(managedPatch(next, 'acp'), next);
  assert.match(next, /historyTool: true/); assert.match(next, /evolution-orchestrator\n  disabled: true/);
  assert.match(managedPatch(user, 'desktop'), /evolution-orchestrator\n  disabled: false/);
  assert.throws(() => managedPatch('# BEGIN dsh-evolution shared experience\n', 'web'), /Ambiguous/);
  assert.equal(yaml.load(managedPatch('# official stock\n[]\n', 'acp')).length, 3);
});

test('daily collector configuration leaves manual lifecycle and startup canary hooks intact', () => {
  const listeners = new Map(); const names = [];
  const ctx = { dynamicCordisRunner: {}, tools: { register: definition => names.push(definition.name) },
    systemPrompt: { section() {} }, on: (name, callback) => listeners.set(name, callback) };
  const core = applyCore(ctx, { memory: {}, eventBridge: {}, startupDrift: false,
    domainStorage: {}, dailyAutonomousObservation: false, autonomous: true });
  assert.ok(listeners.has('agent/pre-step'));
  assert.ok(!listeners.has('agent/error')); assert.ok(!listeners.has('tools/result'));
  for (const name of ['evolution_trial', 'evolution_measure', 'evolution_promote', 'evolution_revert']) assert.ok(names.includes(name));
  assert.equal(typeof core.trial, 'function');
});

test('shared publication can recover from the authenticated bridge without trusting a foreign event', t => {
  const root = temporary(t); const store = openSharedExperience(path.join(root, 'shared')); t.after(() => store.close());
  const file = path.join(root, 'execution-events.jsonl'); const key = 'a'.repeat(64);
  const bridge = new EvolutionEventBridge({ file, key });
  bridge.emit('promotion-succeeded', { id: 'exp-a', proposal: { target: 'tool-a' } });
  const publish = event => store.recordEvolution(event, file);
  new EvolutionEventBridge({ file, key, onVerifiedEvent: publish });
  new EvolutionEventBridge({ file, key, onVerifiedEvent: publish });
  assert.deepEqual(store.stats(), { events: 1, knowledge: 1 });
  const foreign = new EvolutionEventBridge({ file: path.join(root, 'foreign.jsonl'), key, writer: 'another-writer' });
  foreign.emit('promotion-succeeded', { id: 'exp-b', proposal: { target: 'tool-b' } });
  fs.appendFileSync(file, fs.readFileSync(foreign.file));
  new EvolutionEventBridge({ file, key, onVerifiedEvent: publish });
  assert.equal(store.stats().events, 1);
});
