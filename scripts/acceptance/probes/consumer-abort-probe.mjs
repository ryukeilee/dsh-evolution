/**
 * Acceptance probe: prove a promoted plugin really mounts and its tool is
 * callable inside an isolated ACP consumer host.
 *
 * This probe is inserted into the isolated profile through `--patch` by
 * `scripts/acceptance/reproduce-consumer-shutdown-state.mjs`. It takes no
 * arguments; the runner passes the environment:
 *
 *   EVOLUTION_ENTRY_PROBE_OUT       receipt file (required; file-receipt entry)
 *   EVOLUTION_CONSUMER_ABORT_TOOL   the promoted tool name to look for
 *   EVOLUTION_CONSUMER_ABORT_MARKER the promoted event marker to look for
 *   EVOLUTION_CONSUMER_ABORT_STATE  consumer state path (optional; derived from
 *                                   $DSH_HOME when absent)
 *   EVOLUTION_CONSUMER_ABORT_PROFILE expected consumer profile (default: acp)
 *   EVOLUTION_CONSUMER_ABORT_LABEL  label copied into the receipt (optional)
 *
 * The probe writes one receipt:
 *   {
 *     ok, label, profile, startedAt, finishedAt,
 *     tools: [names],
 *     tool: { name, found, hasExecute, executeSource, parameters, execution },
 *     marker: { name, listeners, hits },
 *     consumerState: { sessionId, updatedAt, observedIndexUpdatedAt, rows },
 *     versions: { node, electron, chrome }
 *   }
 *
 * `execution` is `{ attempted: false }` when no definition exposes an
 * `execute` function; otherwise it records the returned value or a bounded
 * error. The probe never throws from `apply()` and never blocks the boot: a
 * failure is written into the receipt and the host keeps running.
 *
 * A `wx` lock next to the receipt makes exactly one applied instance the
 * driver; the profile tree is awaited for 1500 ms before the run so the
 * promoted plugin has settled (the same pattern as
 * `cross-entry-consumer-probe.mjs`).
 */
import fs from 'node:fs';
import path from 'node:path';

export const inject = ['tools'];

const PROBE_INSTANCE_KEY = Symbol.for('dsh-evolution.consumer-abort-probe');
const probeInstances = (globalThis[PROBE_INSTANCE_KEY] ??= { count: 0, driver: false });

function readJsonFile(file) {
  try {
    return { status: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', value: null };
    return { status: 'invalid', value: null, error: String(error?.code || error?.message || error) };
  }
}

function consumerStatePath() {
  if (process.env.EVOLUTION_CONSUMER_ABORT_STATE) return process.env.EVOLUTION_CONSUMER_ABORT_STATE;
  if (!process.env.DSH_HOME) return null;
  return path.join(process.env.DSH_HOME, 'storages', 'evolution', 'shared-plugins', 'consumers', 'acp.json');
}

function bounded(value, limit = 2000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function listenerCount(ctx, name) {
  try {
    const hooks = ctx?.events?._hooks?.[name];
    return Array.isArray(hooks) ? hooks.length : 0;
  } catch {
    return 0;
  }
}

/** The definition the model-facing schema list exposes for `name`, or null. */
function schemaDefinition(ctx, name) {
  try {
    const schemas = typeof ctx?.tools?.schemas === 'function' ? ctx.tools.schemas() : [];
    return Array.isArray(schemas) ? schemas.find((entry) => entry?.name === name) ?? null : null;
  } catch {
    return null;
  }
}

/** The live registry definition (may carry `execute` when schemas() does not). */
function registryDefinition(ctx, name) {
  try {
    if (typeof ctx?.tools?.get !== 'function') return null;
    return ctx.tools.get(name) ?? null;
  } catch {
    return null;
  }
}

function definitionParameters(definition) {
  try {
    const parameters = definition?.parameters;
    if (parameters && typeof parameters === 'object') return bounded(JSON.stringify(parameters), 4000);
    return null;
  } catch {
    return null;
  }
}

async function executeOnce(definition) {
  const controller = new AbortController();
  try {
    const value = await definition.execute({}, { signal: controller.signal });
    return { attempted: true, ok: true, result: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: bounded(String(error?.message || error)),
      code: typeof error?.code === 'string' ? error.code : null,
      name: typeof error?.name === 'string' ? error.name : null,
    };
  } finally {
    controller.abort();
  }
}

export async function runConsumerAbortProbe(ctx) {
  const startedAt = new Date().toISOString();
  const label = process.env.EVOLUTION_CONSUMER_ABORT_LABEL || null;
  const expectedProfile = process.env.EVOLUTION_CONSUMER_ABORT_PROFILE || 'acp';
  const toolName = process.env.EVOLUTION_CONSUMER_ABORT_TOOL || null;
  const markerName = process.env.EVOLUTION_CONSUMER_ABORT_MARKER || null;

  let profile = null;
  try {
    profile = typeof ctx?.get === 'function' ? (ctx.get('profileContext')?.name ?? null) : null;
  } catch {
    profile = null;
  }

  let toolNames = [];
  try {
    const schemas = typeof ctx?.tools?.schemas === 'function' ? ctx.tools.schemas() : [];
    toolNames = Array.isArray(schemas) ? schemas.map((entry) => String(entry?.name ?? '')).filter(Boolean).sort() : [];
  } catch {
    toolNames = [];
  }

  // The model-facing schema list does not expose `execute` on this host, so the
  // live registry definition is the only way to prove the tool is callable. The
  // receipt records which source carried the callable definition.
  const fromSchema = toolName ? schemaDefinition(ctx, toolName) : null;
  const schemaCallable = Boolean(fromSchema) && typeof fromSchema.execute === 'function';
  const fromRegistry = toolName && !schemaCallable ? registryDefinition(ctx, toolName) : null;
  const callable = schemaCallable ? fromSchema : (fromRegistry && typeof fromRegistry.execute === 'function' ? fromRegistry : null);
  const definition = fromSchema ?? fromRegistry;
  let execution = { attempted: false };
  if (callable) {
    execution = await executeOnce(callable);
    execution.source = schemaCallable ? 'schemas' : 'get';
  }

  let marker = { name: markerName, listeners: null, hits: null, error: null };
  if (markerName) {
    const listeners = listenerCount(ctx, markerName);
    marker.listeners = listeners;
    if (listeners > 0 && typeof ctx?.parallel === 'function') {
      try {
        const payload = { hits: 0 };
        await ctx.parallel(markerName, payload);
        marker.hits = Number(payload.hits) || 0;
      } catch (error) {
        marker.error = bounded(String(error?.message || error));
      }
    } else {
      marker.hits = 0;
    }
  }

  const statePath = consumerStatePath();
  const stateRead = statePath ? readJsonFile(statePath) : { status: 'absent', value: null };
  const state = stateRead.status === 'ok' && stateRead.value && typeof stateRead.value === 'object' ? stateRead.value : null;

  return {
    label,
    expectedProfile,
    profile,
    statePath,
    startedAt,
    finishedAt: new Date().toISOString(),
    tools: toolNames,
    tool: {
      name: toolName,
      found: Boolean(definition),
      hasExecute: Boolean(callable),
      schemaHadExecute: schemaCallable,
      executeSource: schemaCallable ? 'schemas' : callable ? 'get' : null,
      parameters: definitionParameters(definition),
      execution,
    },
    marker,
    consumerState: state ? {
      status: stateRead.status,
      sessionId: typeof state.sessionId === 'string' ? state.sessionId : null,
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
      observedIndexUpdatedAt: typeof state.observedIndexUpdatedAt === 'string' ? state.observedIndexUpdatedAt : null,
      disposedAt: typeof state.disposedAt === 'string' ? state.disposedAt : null,
      rows: (Array.isArray(state.plugins) ? state.plugins : []).map((row) => ({
        id: row?.id ?? null,
        status: row?.status ?? null,
        reason: row?.reason ?? null,
        activatedAt: row?.activatedAt ?? null,
        sourceSha256: row?.sourceSha256 ?? null,
      })),
    } : { status: stateRead.status, sessionId: null, updatedAt: null, observedIndexUpdatedAt: null, disposedAt: null, rows: [] },
    versions: {
      node: process.versions?.node ?? null,
      electron: process.versions?.electron ?? null,
      chrome: process.versions?.chrome ?? null,
    },
    probeInstances: probeInstances.count,
    platform: { platform: process.platform, arch: process.arch },
  };
}

export function apply(ctx) {
  probeInstances.count += 1;
  const output = process.env.EVOLUTION_ENTRY_PROBE_OUT;
  if (!output || probeInstances.driver) return;
  probeInstances.driver = true;

  // Exactly one process writes the receipt even when a stale lock is present.
  let driver = false;
  try {
    fs.closeSync(fs.openSync(`${output}.lock`, 'wx', 0o600));
    driver = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (!driver) return;

  const write = (payload) => {
    try {
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      // A receipt that cannot be written must not turn into a boot failure.
    }
  };

  const timer = setTimeout(() => {
    void runConsumerAbortProbe(ctx).then(
      (result) => write({ ok: true, ...result }),
      (error) => write({ ok: false, error: bounded(String(error?.stack || error), 4000) }),
    );
  }, 1500);
  ctx.effect(() => () => clearTimeout(timer));
}

