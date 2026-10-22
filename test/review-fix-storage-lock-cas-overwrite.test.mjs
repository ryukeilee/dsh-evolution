/**
 * A commit must not publish a pending record over a document it never read.
 *
 * The lock fence proves which entry the lock path holds, and it refuses a port
 * whose lock was taken. It cannot see the other half of the same interleaving:
 * a port that still owns the lock entry but whose *document* was committed by
 * someone else. The reviewer's reproducer made that concrete - a reclaim
 * isolates the lock entry it inspected, which frees the path, a second port
 * takes it and commits, and the first port's keyed write then replaces the
 * document it never read. The first port does report the lock error later, but
 * only after its write destroyed the second port's commit.
 *
 * `mutate()` therefore compares its baseline against the committed state right
 * before it publishes, and publishes nothing when they differ:
 *
 *  - the document this port knows (its own domain handle's live value), which
 *    catches a same-process writer sharing that handle;
 *  - the durable commit token that every write of that document advances, which
 *    is the only evidence of another port's commit this process can read - the
 *    official domain handle returns the value this process loaded, never a
 *    fresh read of the medium.
 *
 * Both tests below fail on the pre-change implementation: the refused commit
 * published its pending record anyway, and the writer whose document it never
 * read was gone from the medium (restart count: 1, the wrong writer).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDomainStorage } from '../lib/domain-storage.js';
import { EvolutionEventBridge } from '../lib/orchestrator.js';
import { EvolutionObservationStore } from '../lib/dockyard-domain/index.js';
// The official storage packages are dev dependencies of this repo, so the
// domain integration is exercised against the real official implementation.
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain');
const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json');

const LOCK_NAME = 'domain-archive.lock';
const OFFICIAL = path.join('official', 'evolution_domain.json');
const STAGING = 'domain-staging';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-lock-cas-'));
  const backends = [];
  // Every port gets its own facility over the same medium, which is what two
  // processes (or the reclaiming child of the audit reproducer) see.
  const context = () => {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    backends.push(backend);
    const ctx = { emit() {}, logger: { warn() {}, error() {} }, storage: { backend: { get: () => backend } }, effect() {} };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    return ctx;
  };
  const config = { presetDir: root, eventBridgePath: path.join(root, 'execution-events.jsonl'), eventBridgeKey: 'b'.repeat(64) };
  return { root, context, config, backends, lock: path.join(root, LOCK_NAME),
    bridge: () => new EvolutionEventBridge({ file: config.eventBridgePath, key: config.eventBridgeKey }) };
}

async function teardown(f) {
  for (const backend of f.backends) await backend.close();
  fs.rmSync(f.root, { recursive: true, force: true });
}

/** The durable domain document both ports share. */
const document = f => JSON.parse(fs.readFileSync(path.join(f.root, OFFICIAL), 'utf8')).global;
const aggregateContains = (f, needle) => JSON.stringify(document(f).aggregate).includes(needle);
const stagedDirectories = f => {
  const root = path.join(f.root, STAGING);
  return fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.startsWith('stage-')) : [];
};

/**
 * Run `interleave` once inside the port's own transaction: the observation
 * store's write is the last awaited step before `mutate()` publishes, so
 * everything `interleave` commits is committed after this transaction read its
 * baseline and before it publishes - the window the review named.
 */
async function duringNextMutation(interleave, run) {
  const original = EvolutionObservationStore.prototype.record;
  let armed = true;
  EvolutionObservationStore.prototype.record = async function once(...args) {
    // Disarm before awaiting: a port this hook opens commits through the same
    // prototype and must not re-enter the interleaving.
    if (armed) {
      armed = false;
      await interleave();
    }
    return original.apply(this, args);
  };
  try { return await run(); } finally { EvolutionObservationStore.prototype.record = original; }
}

test('C1: a commit the port never read is refused instead of published over', async () => {
  const f = await fixture();
  const ctx = f.context();
  const port = await openDomainStorage(ctx, f.config);
  const isolated = `${f.lock}.${randomUUID()}.isolated`;

  const error = await duringNextMutation(async () => {
    // The audit's interleaving, reproduced with the lock entry left intact:
    // the reclaim isolates the entry it inspected (which frees the path and
    // keeps its identity on disk under a private name), the second port takes
    // the path and completes a whole commit, releases it, and the isolated
    // entry is then put back exactly where it was - same inode, same bytes, so
    // the first port's fence still passes.
    fs.renameSync(f.lock, isolated);
    const other = await openDomainStorage(f.context(), f.config);
    await other.observe({ code: 'WRITER_C', target: 'tool:c' });
    await other.close();
    fs.renameSync(isolated, f.lock);
  }, () => port.observe({ code: 'WRITER_B', target: 'tool:b' }).then(() => null, caught => caught));

  assert.ok(error, 'the transaction whose baseline is stale must fail');
  assert.match(String(error.message), /E_DOMAIN_ARCHIVE_LOCK/, 'the refusal keeps the lock error code');
  assert.match(String(error.message), /changed by another commit/, 'the refusal names the shared document as the cause');

  // Nothing of the refused transaction reached the shared document.
  assert.equal(document(f).pending, null, 'the refused transaction published no pending record');
  assert.equal(aggregateContains(f, 'WRITER_B'), false, 'the refused transaction wrote none of its aggregate');
  assert.equal(aggregateContains(f, 'WRITER_C'), true, "the other port's committed aggregate is intact");
  assert.deepEqual(stagedDirectories(f).length, 1,
    'the refused transaction keeps its stage on disk, exactly like the other refusal paths');
  assert.equal(port.query('observations').count, 0, 'the refused transaction is not visible on its own port either');

  // Releasing the port reports the failure and still releases its own lock.
  await assert.rejects(port.close(), /E_DOMAIN_ARCHIVE_LOCK/);
  assert.equal(fs.existsSync(f.lock), false, 'a failed port still releases the lock it owns');

  const restarted = await openDomainStorage(f.context(), f.config);
  assert.equal(restarted.query('observations').count, 1,
    'exactly one writer committed, so exactly one observation survives the restart');
  assert.equal(aggregateContains(f, 'WRITER_C'), true, "the restart installs the commit that was read, not the refused one");
  assert.equal(aggregateContains(f, 'WRITER_B'), false);
  await restarted.close();
  await teardown(f);
});

test('C1: a writer that replaced this port\'s own document is refused the same way', async () => {
  const f = await fixture();
  const ctx = f.context();
  const port = await openDomainStorage(ctx, f.config);
  const handle = ctx.storageDomain.get('evolution_domain').global;
  // An empty-but-valid evolution aggregate: the committed aggregate this port
  // did not produce, so the transaction's digest no longer matches.
  const foreign = { schema: 1, aggregate: { evolution: { schema: 4 } }, applied: {}, pending: null };

  const error = await duringNextMutation(async () => {
    // A same-process writer sharing this port's domain handle. The port's own
    // view changes with it, so the document comparison alone can see it.
    await handle.set(foreign);
  }, () => port.observe({ code: 'WRITER_B', target: 'tool:b' }).then(() => null, caught => caught));

  assert.ok(error, 'the transaction whose document changed underneath it must fail');
  assert.match(String(error.message), /E_DOMAIN_ARCHIVE_LOCK/);
  assert.match(String(error.message), /changed by another commit/);
  assert.equal(document(f).pending, null, 'the refused transaction published no pending record');
  assert.equal(aggregateContains(f, 'WRITER_B'), false, 'the refused transaction wrote none of its aggregate');
  assert.equal(document(f).aggregate.evolution.schema, 4, "the writer's document is what stays committed");
  assert.equal(port.query('observations').count, 0);

  await assert.rejects(port.close(), /E_DOMAIN_ARCHIVE_LOCK/);
  const restarted = await openDomainStorage(f.context(), f.config);
  assert.equal(restarted.query('observations').count, 0, 'no observation from the refused transaction was installed');
  assert.equal(document(f).aggregate.evolution.schema, 4);
  await restarted.close();
  await teardown(f);
});

test('C1 control: consecutive commits, restart, staged recovery and replay still commit', async () => {
  const f = await fixture();
  const port = await openDomainStorage(f.context(), f.config);
  // Consecutive commits on one port: each transaction's baseline is the commit
  // the previous one published, so the comparison never refuses a normal write.
  for (let index = 1; index <= 5; index++) {
    // Distinct targets: the knowledge accumulator keeps one source row per
    // component signal, so a repeated signal refreshes instead of appending.
    await port.observe({ code: `WRITER_SEQ_${index}`, target: `tool:seq-${index}` });
    assert.equal(port.query('observations').count, index, `commit ${index} is visible on the port`);
    assert.equal(document(f).pending, null, `commit ${index} closed its pending record`);
  }
  await port.close();

  const reopened = await openDomainStorage(f.context(), f.config);
  assert.equal(reopened.query('observations').count, 5, 'every consecutive commit survives the restart');

  // The event bridge still commits through the same publication path.
  const bridge = f.bridge();
  bridge.emit('trial-completed', { id: 'exp-safe', proposal: { target: 'plugin:safe' } });
  assert.equal((await reopened.replay()).applied, 1, 'replay commits its event');
  assert.equal((await reopened.replay()).duplicates, 1, 'an absorbed event stays absorbed');
  await reopened.observe({ code: 'WRITER_AFTER_REPLAY', target: 'tool:after' });
  assert.equal(reopened.query('observations').count, 6, 'a commit after replay succeeds');
  // A pending record exists only for a transaction that staged archive bytes, so
  // the observation hot window is filled to its limit first: the crashing write
  // below then evicts one observation into the active archive and commits through
  // the pending record the injected failure interrupts. The warm-up is committed
  // before the injection is armed, so it cannot trip it.
  for (let index = 0; index < 44; index++) {
    await reopened.observe({ code: `WRITER_WARM_${index}`, target: `tool:warm-${index}` });
  }
  assert.equal(reopened.query('observations').count, 50, 'the warm-up fills the observation hot window exactly');
  await reopened.close();

  // A crash between the publication and the install leaves a committed pending
  // record; the next open installs it. The install advances the commit token
  // too, and a commit after it still compares equal to its own baseline.
  //
  const crashCtx = f.context();
  const crashing = await openDomainStorage(crashCtx, f.config);
  const handle = crashCtx.storageDomain.get('evolution_domain').global;
  const set = handle.set;
  let injected = false;
  handle.set = async value => {
    if (!injected && value.pending === null && Object.keys(value.applied).length) {
      injected = true;
      throw new Error('INJECTED_FINAL_COMMIT');
    }
    return set(value);
  };
  await assert.rejects(crashing.observe({ code: 'WRITER_CRASH', target: 'tool:crash' }), /INJECTED_FINAL_COMMIT/);
  assert.notEqual(document(f).pending, null, 'the publication is durable before the install fails');
  assert.ok(document(f).pending.files.some(entry => entry.file.includes('observations-archive')),
    'the interrupted commit must be the one that staged the evicted observation');
  await assert.rejects(crashing.close(), /INJECTED_FINAL_COMMIT/);

  const recovered = await openDomainStorage(f.context(), f.config);
  assert.equal(document(f).pending, null, 'the recovered record is installed and closed');
  assert.equal(recovered.query('observations').count, 51, 'the interrupted commit is installed on recovery');
  await recovered.observe({ code: 'WRITER_AFTER_RECOVERY', target: 'tool:recovered' });
  assert.equal(recovered.query('observations').count, 52, 'a commit after the recovery still succeeds');
  await recovered.close();
  await teardown(f);
});
