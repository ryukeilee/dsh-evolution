import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';
import { verifyEventBridgeEnvelope } from './orchestrator.js';
import { eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay,
  readEventLogCheckpoint, writeEventLogCheckpoint } from './event-log-checkpoint.js';
import { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,
  privatizeArchiveFile, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';

const json = z.json();
// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).
// JSON is the durable medium, and the old file backend already dropped those
// fields through JSON.stringify, so normalize to the exact JSON projection before
// validating: this keeps strict JSON validation without silently changing state.
const toJsonProjection = value => JSON.parse(JSON.stringify(value));
const aggregateSchema = z.preprocess(toJsonProjection,
  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).catchall(json).optional() }).strict());
const appliedSchema = z.record(z.string(), z.string());
const archiveFilesSchema = z.array(z.object({ file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict());
const schema = z.object({ schema: z.literal(1), aggregate: aggregateSchema, applied: appliedSchema,
  pending: z.object({ stage: z.string().regex(/^stage-[a-f0-9-]+$/), aggregate: aggregateSchema, applied: appliedSchema, files: archiveFilesSchema.optional() }).strict().nullable() }).strict();
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
/**
 * Mirrors the official `defineDomain` fail-loud checks (dsh-storage-domain/src/spec.ts)
 * for this hand-written spec: both storage backends reject a unit name outside
 * `UNIT_NAME_RE`, and a global schema that accepts `null` would collide with the
 * medium's "never written" sentinel. The plugin does not import the domain package
 * at runtime; it consumes the host `ctx.storageDomain` service instead.
 */
export function assertDomainSpec(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`Evolution domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`Evolution domain '${spec.name}' version must be a non-negative integer`);
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`Evolution domain '${spec.name}' table '${table}' must match ${UNIT_NAME_RE}`);
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(`Evolution domain '${spec.name}' global schema must not accept null`);
  }
  return spec;
}
export const evolutionDomainSpec = assertDomainSpec({
  name: 'evolution_domain', version: 1, tables: {},
  global: { schema, initial: { schema: 1, aggregate: {}, applied: {}, pending: null } },
});
/**
 * Acquire the cross-process archive lock. A lock whose owner is dead, or whose
 * content was never written (the writer was killed between create and write),
 * must not brick the plugin: an unparsable lock is reclaimed only after it has
 * definitively settled, so an in-flight writer can never be displaced.
 */
const LOCK_SETTLE_MS = 1000;
const LOCK_RETRY_MS = 5000;
function lockOwnerPid(lock) {
  let raw;
  try { raw = fs.readFileSync(lock, 'utf8').trim(); } catch { return undefined; }
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
function reclaimLock(lock) {
  try { fs.unlinkSync(lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
async function acquireArchiveLock(lock) {
  const deadline = Date.now() + LOCK_RETRY_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const pid = lockOwnerPid(lock);
      if (pid === null || pid === undefined) {
        let ageMs = 0;
        try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (ageMs >= LOCK_SETTLE_MS) { reclaimLock(lock); continue; }
        if (Date.now() >= deadline) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (pid === process.pid || ownerAlive(pid)) throw new Error('E_DOMAIN_ARCHIVE_LOCK');
      reclaimLock(lock);
    }
  }
}
/** No authority token or mutable Memory is exported. Every mutation is queued,
 * staged and committed by this private port. The journal is NOT cross-medium atomic. */
export async function openDomainStorage(ctx, config) {
  const lock = path.join(config.presetDir, 'domain-archive.lock');
  await acquireArchiveLock(lock);
  let domain;
  try { domain = await ctx.storageDomain.open(evolutionDomainSpec); }
  catch (error) { fs.unlinkSync(lock); throw error; }
  const root = path.join(config.presetDir, 'dockyard');
  const staging = path.join(config.presetDir, 'domain-staging');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  const scope = new AsyncLocalStorage();
  const token = {};
  const authority = { assertMutation() { if (scope.getStore() !== token) throw new Error('E_MUTATION_AUTHORITY_REQUIRED'); } };
  let chain = Promise.resolve(), closing = false, disposal, failure;
  let memory, observations;
  const evaluator = new EvolutionEvaluator();
  function enqueue(job) {
    if (closing) return Promise.reject(new Error('E_DOMAIN_CLOSED'));
    const result = chain.then(() => scope.run(token, job));
    chain = result.then(() => {}, error => { failure = error; });
    return result;
  }
  async function installPending() {
    const current = schema.parse(domain.global.get());
    if (!current.pending) return;
    const source = stageDirectory(staging, current.pending.stage);
    if (!fs.existsSync(source)) throw new Error('E_DOMAIN_PENDING_ARCHIVE_MISSING');
    // The durable pending record carries the exact list of files the stage
    // changed, with their digests, so recovery installs those files (atomic
    // replace, replayable, never recomputing a partially applied event) and
    // leaves everything else untouched: a staged file that was not written is
    // a hard link to the live, already durable file. A stage that carries no
    // durable file list - one written by an older version - is replayed as a full copy.
    const files = current.pending.files;
    if (files) installArchiveFiles(source, root, files);
    else { copyArchives(source, root); syncTree(root); }
    await domain.global.set(schema.parse({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null }));
    fs.rmSync(source, { recursive: true });
  }
  async function createMemory(dir, initial, archiveWriteGuard = null) {
    let aggregate = structuredClone(initial);
    const stateStore = { filePath: path.join(dir, 'state.json'), load: async () => structuredClone(aggregate),
      update: async updater => { aggregate = aggregateSchema.parse(updater(structuredClone(aggregate))); } };
    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });
    await instance.load();
    return { instance, getAggregate: () => structuredClone(aggregate) };
  }
  async function hydrate() {
    const index = path.join(root, 'state.json.evolution-archive-index.json');
    const before = fs.existsSync(index) ? fs.statSync(index).ino : null;
    const current = await createMemory(root, domain.global.get().aggregate);
    memory = current.instance;
    observations = new EvolutionObservationStore({ memory });
    await observations.load();
    // Loading may repair the derived index by atomic replacement. Keep that
    // repaired file durable before a later stage shares its inode.
    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }
  }
  async function mutate(work, applied = domain.global.get().applied) {
    await installPending();
    const stage = `stage-${randomUUID()}`;
    const dir = stageDirectory(staging, stage);
    // The stage is a hard-link mirror of the live tree: complete and correct
    // without copying, and unchanged files need no fsync because they are the
    // bytes that were already durable in the committed tree.
    const snapshot = mirrorArchives(root, dir);
    const privatized = new Set();
    const archiveWriteGuard = file => privatizeArchiveFile({ directory: dir, snapshot, privatized, file });
    const current = await createMemory(dir, domain.global.get().aggregate, archiveWriteGuard);
    const store = new EvolutionObservationStore({ memory: current.instance });
    const result = await work(current.instance, store);
    // Even a deduplicated operation must retain load/maintenance changes.
    const aggregate = { evolution: current.instance.snapshot() };
    // Nothing may have written the live tree through the staged mirror; if it
    // did, the stage no longer describes the committed archive and the
    // transaction fails loudly instead of installing a mixed tree.
    assertLiveTreeUnchanged(root, snapshot);
    const files = changedArchiveFiles(dir, snapshot);
    // The stage commits before the aggregate: recovery can always replay the
    // staged files and then commit, and never recomputes an event whose
    // marker is already durable. Files the writer did not touch are hard
    // links to the committed tree, so an empty change list installs nothing.
    writeStageManifest(dir, files);
    syncStage({ directory: dir, stagingRoot: staging, files });
    await domain.global.set(schema.parse({ schema: 1, aggregate: domain.global.get().aggregate, applied: domain.global.get().applied, pending: { stage, aggregate, applied, files } }));
    await installPending();
    await hydrate();
    return result;
  }
  async function replay() {
    const writer = config.eventBridgeWriter || 'dsh-evolution-orchestrator';
    const checkpointFile = eventLogCheckpointPath(config.presetDir);
    // The stored checkpoint lets an authenticated, already absorbed prefix skip
    // per-record work. It is only trusted when its keyed digest matches the
    // bytes on disk now, so any change to consumed history still falls back to
    // full per-record verification below.
    const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,
      checkpoint: readEventLogCheckpoint(checkpointFile), applied: domain.global.get().applied });
    if (!plan) return { applied: 0, duplicates: 0 };
    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;
    let first = null, last = null;
    const absorb = async (line, { witnessed }) => {
      const envelope = JSON.parse(line);
      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);
      if (!verified || verified.writer !== writer) throw new Error('E_DOMAIN_EVENT_AUTH');
      const eventId = safeIdentifier(verified.event.eventId);
      if (witnessed) {
        const witness = { id: String(eventId), mac: envelope.mac };
        first ??= witness;
        last = witness;
      }
      // The committed domain marker covers the complete single-event batch.
      // Authenticate every record the checkpoint does not cover, including
      // duplicates, before consulting it. Already committed events need
      // neither a second parse nor a full DTO.
      const marker = domain.global.get().applied[eventId];
      if (marker) {
        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
        duplicates++; return;
      }
      const event = projectExecutionEvent(verified.event);
      const result = await mutate(instance => instance.applyExecutionEvent(event), { ...domain.global.get().applied, [event.eventId]: envelope.mac });
      if (result.duplicate) duplicates++; else applied++;
    };
    for (const line of plan.lines) {
      if (!line.trim()) continue;
      await absorb(line, { witnessed: true });
    }
    // A torn trailing line is processed exactly as before but stays outside
    // the checkpoint, so a later append re-processes it instead of silently
    // skipping bytes that were never a complete record.
    if (plan.remainder.trim()) await absorb(plan.remainder, { witnessed: false });
    if (plan.advance) {
      try {
        writeEventLogCheckpoint(checkpointFile, eventLogCheckpointDocument({ plan, writer, key: config.eventBridgeKey, applied: domain.global.get().applied, witnesses: { first, last } }));
      } catch (error) {
        // Losing the checkpoint only means the next pass re-verifies history.
        ctx.logger?.warn?.(`[evolution] event log checkpoint not written: ${error?.message || error}`);
      }
    }
    return { applied, duplicates };
  }
  try {
    await scope.run(token, async () => {
      await installPending();
      if (!domain.global.get().aggregate.evolution && config.domainSeed === true) {
        // Only explicitly authorized NEW-root seed; never discover another home.
        const seed = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));
      }
      await hydrate();
      // Establish durability once for archives inherited from older versions
      // or an explicitly seeded root, before sharing unchanged files.
      syncTree(root);
      syncFile(config.presetDir);
      await replay();
    });
  } catch (error) { await domain.close(); fs.unlinkSync(lock); throw error; }
  const close = () => {
    closing = true;
    return disposal ??= (async () => { await chain; await domain.close(); fs.unlinkSync(lock); if (failure) throw failure; })();
  };
  ctx.effect(() => close);
  return Object.freeze({
    replay: () => enqueue(replay),
    flush: () => enqueue(replay),
    observe: dto => enqueue(() => mutate((_memory, store) => store.record(projectObservation(dto)))),
    query: (collection = 'cycles', limit = 10) => {
      if (closing) throw new Error('E_DOMAIN_CLOSED');
      if (!['cycles', 'observations', 'proposals', 'experiments', 'promotions', 'outcomes', 'lineage', 'knowledge'].includes(collection)) throw new Error('E_DOMAIN_QUERY_COLLECTION');
      const rows = memory.historyWindow(collection, limit);
      return { collection, count: rows.count, entries: rows.entries.map(row => ({
        id: safeIdentifier(row.id), status: safeIdentifier(row.status), eventType: safeIdentifier(row.eventType),
        recordedAt: /^\d{4}-\d{2}-\d{2}T/.test(row.recordedAt || '') ? row.recordedAt : null,
      })), promotionMetrics: 'not-integrated-independent-evidence-required' };
    },
    // Evaluator is deliberately advisory, never production authority.
    evaluate: evidence => evaluator.evaluate(evidence), close,
  });
}
const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;
export function projectObservation(input = {}) {
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code || '') ? input.code : 'HOST_OPERATION_FAILED';
  const target = safeIdentifier(input.target) || 'host';
  return { source: 'official-tools', type: input.type === 'agent/error' ? 'agent/error' : 'tool/error',
    code, message: `Official operation failed (${code})`, componentId: target, severity: 'error', status: 'failed' };
}
function projectExecutionEvent(event) {
  const identifier = value => safeIdentifier(value);
  const numeric = value => Object.fromEntries(Object.entries(value || {}).filter(([k,v]) => /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k) && typeof v === 'number' && Number.isFinite(v)));
  return { schema: 1, eventId: identifier(event.eventId), eventType: event.eventType,
    experimentId: identifier(event.experimentId), proposalId: identifier(event.proposalId),
    target: identifier(event.target), capability: identifier(event.capability), lineageId: identifier(event.lineageId),
    status: identifier(event.status), failureFingerprint: identifier(event.failureFingerprint),
    failure: event.failure ? { code: 'EVOLUTION_OPERATION_FAILED' } : null,
    promotion: event.promotion ? { id: identifier(event.promotion.id) } : null,
    measurement: numeric(event.measurement), evidence: {}, canary: {},
    audit: { producer: 'dsh-evolution-orchestrator', at: event.audit?.at },
  };
}
