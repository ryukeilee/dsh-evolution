import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { STAGE_MANIFEST } from '../../lib/archive-stage.js';
import { evolutionDomainSpec, openDomainStorage } from '../../lib/domain-storage.js';
import { normalizeKnowledgeEvent } from '../../lib/dockyard-domain/knowledge.js';
import { EvolutionMemory } from '../../lib/dockyard-domain/memory.js';
import { signEventBridgeEnvelope } from '../../lib/orchestrator.js';

const KEY = 'b'.repeat(64);
const FIXED_AT = '2026-10-26T00:00:00.000Z';
const EVENT_TYPES = [
  'proposal-created',
  'trial-completed',
  'measurement-completed',
  'experiment-rejected',
  'failure-learned',
  'promotion-succeeded',
  'promotion-reverted',
  'canary-passed',
  'canary-failed',
];
const BASELINE_PATH = new URL('../fixtures/domain-storage/execution-event-save-coalescing-baseline.json', import.meta.url);
const BASELINE = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const durablePath = (root) => path.join(root, 'official', 'evolution_domain.json');

const RealDate = globalThis.Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_AT])); }
  static now() { return new RealDate(FIXED_AT).getTime(); }
}

function eventFor(eventType, experimentId = `corpus-${eventType}`) {
  const event = {
    schema: 1,
    eventId: `evolution:${eventType}:${experimentId}`,
    eventType,
    experimentId,
    proposalId: `proposal-${experimentId}`,
    target: 'plugin:coalescing-corpus',
    capability: 'plugin:coalescing-corpus',
    lineageId: 'plugin:coalescing-corpus',
    status: eventType === 'proposal-created' ? 'proposed'
      : eventType === 'experiment-rejected' ? 'rejected'
        : eventType === 'failure-learned' ? 'failed'
          : eventType === 'canary-passed' ? 'stable'
            : eventType === 'canary-failed' ? 'canary-failed'
              : eventType === 'promotion-reverted' ? 'reverted'
                : eventType === 'promotion-succeeded' ? 'promoted' : 'measured',
    measurement: { latency: 10, throughput: 3 },
    evidence: { fitnessScore: 0.75, validationRuns: 1 },
    promotion: { promotionId: `promotion-${experimentId}`, id: `promotion-${experimentId}` },
    canary: { passed: eventType === 'canary-passed', observations: 2 },
    audit: { producer: 'dsh-evolution-orchestrator', at: FIXED_AT },
  };
  if (['experiment-rejected', 'failure-learned', 'promotion-reverted', 'canary-failed'].includes(eventType)) {
    event.failureFingerprint = `failure-${experimentId}`;
    event.failure = { code: 'SYNTHETIC_FAILURE', rootCauseHypothesis: 'synthetic cause' };
  }
  return event;
}

function contextFor(backend) {
  const ctx = { emit() {}, on() { return () => {}; }, logger: { warn() {}, error() {} },
    storage: { backend: { get: () => backend } }, effect() {} };
  ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
  return ctx;
}

async function openWithEvents(events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-save-coalescing-corpus-'));
  const file = path.join(root, 'execution-events.jsonl');
  fs.writeFileSync(file, `${events.map((event, index) => JSON.stringify(signEventBridgeEnvelope(event, { key: KEY, sequence: index + 1 }))).join('\n')}\n`);
  const backend = new JsonStorageBackend(path.join(root, 'official'));
  const ctx = contextFor(backend);
  return { root, file, backend, ctx, config: { presetDir: root, eventBridgePath: file, eventBridgeKey: KEY } };
}

async function withFixedTime(run) {
  globalThis.Date = FixedDate;
  try { return await run(); } finally { globalThis.Date = RealDate; }
}

test('each execution event keeps HEAD acceptance and exact durable bytes', async () => {
  // The fixture is the acceptance oracle, so its provenance must be stated and
  // checked rather than left to a comment: it was generated from this commit.
  assert.match(BASELINE.sourceCommit, /^[0-9a-f]{40}$/, 'the fixture must name the commit it was generated from');
  assert.deepEqual(Object.keys(BASELINE.events), EVENT_TYPES);
  for (const eventType of EVENT_TYPES) {
    const expected = BASELINE.events[eventType];
    const good = await openWithEvents([eventFor(eventType)]);
    let port;
    try {
      await withFixedTime(async () => {
        port = await openDomainStorage(good.ctx, good.config);
        const raw = fs.readFileSync(durablePath(good.root));
        const durable = JSON.parse(raw).global;
        assert.equal(Object.keys(durable.applied).length, 1);
        assert.equal(durable.pending, null);
        assert.equal(raw.toString('base64'), expected.durableBase64, `${eventType} durable bytes differ from HEAD b13fe4c`);
      });
    } finally {
      if (port) await port.close();
      await good.backend.close();
      fs.rmSync(good.root, { recursive: true, force: true });
    }

    const invalid = eventFor(eventType);
    invalid.eventId = `noncanonical-${eventType}`;
    const bad = await openWithEvents([invalid]);
    try {
      await withFixedTime(async () => {
        let caught;
        try { await openDomainStorage(bad.ctx, bad.config); } catch (error) { caught = error; }
        assert.ok(caught, `${eventType} malformed eventId must be rejected`);
        assert.deepEqual({ name: caught.name, message: caught.message }, expected.rejected,
          `${eventType} rejection differs from HEAD b13fe4c`);
        assert.equal(fs.existsSync(durablePath(bad.root)), expected.rejectedDocumentExists);
      });
    } finally {
      await bad.backend.close();
      fs.rmSync(bad.root, { recursive: true, force: true });
    }
  }
});

test('direct memory transactions keep both measurement saves by default', async () => {
  let state = { evolution: { schema: 5 } };
  let persistCalls = 0;
  const stateStore = {
    async load() { return structuredClone(state); },
    async update(updater) { state = updater(state); },
  };
  const memory = new EvolutionMemory({
    stateStore,
    transaction: { persist: async (updater) => { persistCalls += 1; await stateStore.update(updater); } },
    mutationAuthority: { assertMutation() {} },
    archiveWriteGuard: async () => {},
    clock: () => new RealDate(FIXED_AT),
  });
  await memory.load();
  await memory.applyExecutionEvent(eventFor('measurement-completed'));
  assert.equal(persistCalls, 2, 'only openDomainStorage opts its staged working memory into marker coalescing');
});

test('a __proto__ experiment id still aborts the coalesced replay before publication', async () => {
  const event = eventFor('measurement-completed', '__proto__');
  const record = {
    id: `bridge:experiment:${event.experimentId}`,
    experimentId: event.experimentId,
    proposalId: event.proposalId,
    target: event.target,
    capabilityId: event.capability,
    lineageId: event.lineageId,
    source: 'dsh-evolution-orchestrator',
    bridgeEventId: event.eventId,
    predecessor: null,
    supersedes: null,
    recordedAt: FIXED_AT,
    status: 'measured',
    measurement: event.measurement,
    evidence: {},
    failureFingerprint: null,
  };
  const normalized = normalizeKnowledgeEvent(record, { sourceCollection: 'experiments', now: new RealDate(FIXED_AT) });
  assert.equal(normalized, null, 'the projected measurement has no knowledge identity, so recordExperiment keeps its source row');
  // A document nested deeply enough that the recursive own-`__proto__` strip
  // overflows, carrying the literal only through this event's id. Whatever save
  // trips it, a replay that cannot validate its payload must abort before
  // anything is published - which is the property this test owns. It does not
  // claim which save raised the error: with source retention keeping the row,
  // the record save already sees the id, and the marker save never runs. The V8
  // call-stack limit differs across the Node majors in the CI matrix, so each
  // engine family keeps a known depth; an engine that moves the limit fails
  // loudly here rather than passing silently.
  const depth = Number(process.versions.node.split('.')[0]) >= 24 ? 1900 : 1700;
  {
    const deep = {};
    let cursor = deep;
    for (let index = 0; index < depth; index += 1) { cursor.child = {}; cursor = cursor.child; }
    cursor.note = 'deep-json-safe-without-proto';
    const aggregate = { evolution: {
      schema: 5,
      eventBridge: { schema: 1, applied: [] },
      deep,
    } };
    const fixture = await openWithEvents([event]);
    let port;
    try {
      const domain = await fixture.ctx.storageDomain.open(evolutionDomainSpec);
      await domain.global.set({ schema: 1, aggregate, applied: {}, pending: null });
      await domain.close();
      const committedPath = durablePath(fixture.root);
      const committedBefore = fs.readFileSync(committedPath);
      const tokenPath = path.join(fixture.root, 'domain-commit.token');
      fs.writeFileSync(tokenPath, 'baseline-token\n');
      const tokenBefore = fs.readFileSync(tokenPath);
      const originalStringify = JSON.stringify;
      const aggregatePayloads = [];
      JSON.stringify = function (value, ...args) {
        const text = originalStringify.call(this, value, ...args);
        if (value && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).length === 1 && Object.hasOwn(value, 'evolution')) aggregatePayloads.push(text);
        return text;
      };
      let caught;
      try {
        await withFixedTime(async () => {
          try { port = await openDomainStorage(fixture.ctx, fixture.config); } catch (error) { caught = error; }
        });
      } finally {
        JSON.stringify = originalStringify;
      }
      // Only the observable contract is asserted. Which save overflows depends on
      // the engine's call-stack limit and on how far the recursive own-`__proto__`
      // strip gets before it runs out, and the wrapper above only records the
      // payloads whose stringify *returned*, so it cannot identify the thrower.
      assert.ok(aggregatePayloads.length >= 1, 'the replay must check at least one aggregate payload');
      assert.equal(caught?.name, 'RangeError', `Node ${process.versions.node} at depth ${depth}`);
      assert.equal(caught.message, 'Maximum call stack size exceeded');

      assert.deepEqual(fs.readFileSync(committedPath), committedBefore, 'failed replay must not publish the aggregate or event ledger');
      assert.deepEqual(fs.readFileSync(tokenPath), tokenBefore, 'failed replay must not advance the commit token');
      const staging = path.join(fixture.root, 'domain-staging');
      const stageManifests = fs.existsSync(staging) ? fs.readdirSync(staging)
        .map((name) => path.join(staging, name, STAGE_MANIFEST)).filter((file) => fs.existsSync(file)) : [];
      assert.deepEqual(stageManifests, [], 'failure before publication must not write a stage manifest');
    } finally {
      if (port) await port.close();
      await fixture.backend.close();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
