import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';
import { verifyEventBridgeEnvelope } from './orchestrator.js';

const json = z.json();
// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).
// JSON is the durable medium, and the old file backend already dropped those
// fields through JSON.stringify, so normalize to the exact JSON projection before
// validating: this keeps strict JSON validation without silently changing state.
const toJsonProjection = value => JSON.parse(JSON.stringify(value));
const aggregateSchema = z.preprocess(toJsonProjection,
  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).catchall(json).optional() }).strict());
const appliedSchema = z.record(z.string(), z.string());
const schema = z.object({ schema: z.literal(1), aggregate: aggregateSchema, applied: appliedSchema,
  pending: z.object({ stage: z.string().regex(/^stage-[a-f0-9-]+$/), aggregate: aggregateSchema, applied: appliedSchema }).strict().nullable() }).strict();
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
const allowedArchive = name => /^state\.json\.(?:[A-Za-z]+-archive\.jsonl(?:\.segments)?|evolution-archive-index\.json)$/.test(name);
function syncFile(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncTree(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.lstatSync(file).isDirectory()) syncTree(file); else syncFile(file);
  }
  syncFile(dir);
}
function copyArchives(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(from)) return;
  for (const name of fs.readdirSync(from).filter(allowedArchive)) {
    const source = path.join(from, name);
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Archive symlink rejected');
    fs.cpSync(source, path.join(to, name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  }
}
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
    const source = path.join(staging, current.pending.stage);
    if (!fs.existsSync(source)) throw new Error('E_DOMAIN_PENDING_ARCHIVE_MISSING');
    copyArchives(source, root); // replayable overwrite; never recompute a partially applied event
    syncTree(root);
    await domain.global.set(schema.parse({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null }));
    fs.rmSync(source, { recursive: true });
  }
  async function createMemory(dir, initial) {
    let aggregate = structuredClone(initial);
    const stateStore = { filePath: path.join(dir, 'state.json'), load: async () => structuredClone(aggregate),
      update: async updater => { aggregate = aggregateSchema.parse(updater(structuredClone(aggregate))); } };
    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority });
    await instance.load();
    return { instance, getAggregate: () => structuredClone(aggregate) };
  }
  async function hydrate() {
    const current = await createMemory(root, domain.global.get().aggregate);
    memory = current.instance;
    observations = new EvolutionObservationStore({ memory });
    await observations.load();
  }
  async function mutate(work, applied = domain.global.get().applied) {
    await installPending();
    const stage = `stage-${randomUUID()}`;
    const dir = path.join(staging, stage);
    copyArchives(root, dir);
    const current = await createMemory(dir, domain.global.get().aggregate);
    const store = new EvolutionObservationStore({ memory: current.instance });
    const result = await work(current.instance, store);
    // Even a deduplicated operation must retain load/maintenance changes.
    const aggregate = { evolution: current.instance.snapshot() };
    syncTree(dir);
    await domain.global.set(schema.parse({ schema: 1, aggregate: domain.global.get().aggregate, applied: domain.global.get().applied, pending: { stage, aggregate, applied } }));
    await installPending();
    await hydrate();
    return result;
  }
  async function replay() {
    let raw;
    try { raw = fs.readFileSync(config.eventBridgePath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { applied: 0, duplicates: 0 }; throw error; }
    let applied = 0, duplicates = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const envelope = JSON.parse(line);
      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);
      if (!verified || verified.writer !== (config.eventBridgeWriter || 'dsh-evolution-orchestrator')) throw new Error('E_DOMAIN_EVENT_AUTH');
      // The committed domain marker covers the complete single-event batch.
      // Authenticate every record, including duplicates, before consulting it.
      // Already committed events need neither a second parse nor a full DTO.
      const eventId = safeIdentifier(verified.event.eventId);
      const marker = domain.global.get().applied[eventId];
      if (marker) {
        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');
        duplicates++; continue;
      }
      const event = projectExecutionEvent(verified.event);
      const result = await mutate(instance => instance.applyExecutionEvent(event), { ...domain.global.get().applied, [event.eventId]: envelope.mac });
      if (result.duplicate) duplicates++; else applied++;
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
      const rows = memory.history(collection);
      return { collection, count: rows.length, entries: rows.slice(-Math.min(50, Math.max(1, Number(limit) || 10))).map(row => ({
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
