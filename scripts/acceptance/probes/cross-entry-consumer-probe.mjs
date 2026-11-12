/**
 * Acceptance probe: a consumer-only entry (ACP or Web) mounts Desktop-published
 * verified stable plugins through the official Include, without the Evolution
 * kernel.
 *
 * Run commands (the caller sets the environment; the probe takes no arguments):
 *   - host acceptance: booted with `bootProbe` on `--profile web` plus an
 *     overlay row `- id: evolution-orchestrator\n  disabled: true`, driven
 *     through `process.send('run')`.
 *   - ACP / local runner: booted with a file receipt
 *     (`EVOLUTION_ENTRY_PROBE_OUT=<file>`), because those entries have no IPC
 *     channel to the acceptance runner.
 *
 * Environment:
 *   EVOLUTION_CROSS_ENTRY_PROFILE   expected consumer profile (`web`|`acp`)
 *   EVOLUTION_CROSS_ENTRY_EXPECT    JSON { "<pluginId>": { status, reason? } }
 *   EVOLUTION_CROSS_ENTRY_MARKERS   JSON { "<pluginId>": "<event name>" } to fire
 *   EVOLUTION_CROSS_ENTRY_EXPECT_KERNEL  "1" when the full kernel is also booted
 *                                   (the consumer must then skip the record it
 *                                   sees already mounted, and the kernel's 12
 *                                   tools must be present)
 *
 * Assertions (all of them fail the probe, never degrade silently):
 *   - the consumer state row for every published record has the expected status;
 *   - `observedIndexUpdatedAt` equals the publication index `updatedAt`;
 *   - every expected active plugin's listener executes exactly once (one mount,
 *     one registration) and a disabled/skipped plugin's listener is absent;
 *   - the kernel is absent (zero `evolution_*` tools) in a consumer-only entry,
 *     or present with exactly 12 tools when the kernel is also booted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const inject = ['tools'];

/** The tool surface the kernel registers (lib/registration.js#EVOLUTION_TOOLS). */
const EVOLUTION_TOOL_COUNT = 12;
/**
 * `evolution_history` is registered by the bundle's separate
 * `dsh-evolution/experience-history` entry, which `setup-experience` enables in
 * every profile so the shared experience store can be read without a kernel.
 * The kernel-only orchestrator tools are the other eleven: a consumer-only
 * entry must register none of them even though `evolution_history` is present.
 */
const SHARED_EXPERIENCE_TOOL = 'evolution_history';
/**
 * A consumer-only profile may also register its own coordination tool: the ACP
 * profile mounts `dsh-evolution/desktop-task-client`, whose read-only `audit`
 * action coordinates with Desktop without running the Evolution kernel. It is
 * not a kernel tool, so the kernel-absence proof below must not treat it as
 * one; the Web profile has no such entry and allows nothing extra.
 */
const COORDINATION_TOOLS = Object.freeze({
  acp: Object.freeze(['evolution_desktop']),
  web: Object.freeze([]),
});
const KERNEL_ONLY_TOOLS = Object.freeze([
  'evolution_runtime_inspect',
  'evolution_plan',
  'evolution_propose',
  'evolution_trial',
  'evolution_probe',
  'evolution_measure',
  'evolution_revert',
  'evolution_promote',
  'evolution_canary_observe',
  'evolution_maintain',
  'evolution_doctor',
]);

/**
 * One probe driver per process. The Desktop host can compose the same profile
 * patch into more than one live context in one process; two live instances
 * would each dispatch the marker once and each report `hits === 1`, hiding a
 * double execution from the runner. The first instance drives and records how
 * many instances the process composed.
 */
const PROBE_INSTANCE_KEY = Symbol.for('dsh-evolution.cross-entry-consumer-probe');
const probeInstances = (globalThis[PROBE_INSTANCE_KEY] ??= { count: 0, driver: false });

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error?.message || error}`);
  }
}

function dataRootFromEnvironment() {
  if (process.env.EVOLUTION_CROSS_ENTRY_DATA_ROOT) return process.env.EVOLUTION_CROSS_ENTRY_DATA_ROOT;
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('DSH_HOME is required to locate the shared plugin state');
  return path.join(home, 'storages', 'evolution');
}

function readJsonFile(file) {
  try {
    return { status: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', value: null };
    return { status: 'invalid', value: null, error: String(error?.code || error?.message || error) };
  }
}

export function apply(ctx) {
  // Count live applications, not module evaluations: a host that composes the
  // same patch into several contexts evaluates this module once and applies it
  // once per context. The run below refuses anything but one application.
  probeInstances.count += 1;
  const output = process.env.EVOLUTION_ENTRY_PROBE_OUT;
  const report = (promise) => {
    void promise.then(
      (result) => {
        if (output) return fs.writeFileSync(output, `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        process.send?.({ result });
        return undefined;
      },
      (error) => {
        const payload = { ok: false, error: `${String(error?.stack || error)}`.slice(0, 4000) };
        if (output) return fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
        process.send?.({ error: payload.error });
        return undefined;
      },
    );
  };
  const receive = (message) => {
    if (output || message !== 'run') return;
    report(runConsumerProbe(ctx));
  };
  if (probeInstances.driver) return;
  probeInstances.driver = true;
  if (!output) {
    ctx.effect(() => {
      process.on('message', receive);
      return () => process.off('message', receive);
    });
  }
  if (output) {
    // A file-receipt entry has no IPC channel: run once the profile tree has
    // settled. A `wx` lock makes exactly one instance the driver even if a
    // second probe process shares the receipt path.
    let driver = false;
    try {
      fs.closeSync(fs.openSync(`${output}.lock`, 'wx', 0o600));
      driver = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!driver) return;
    const timer = setTimeout(() => report(runConsumerProbe(ctx)), 1500);
    ctx.effect(() => () => clearTimeout(timer));
  }
  // A file-receipt entry (Desktop, ACP) owns no IPC channel: `process.send` there
  // would inject a foreign message into the host's own parent/child protocol.
  if (!output) process.send?.({ ready: true });
}

export async function runConsumerProbe(ctx) {
  if (probeInstances.count !== 1) {
    throw new Error(`the consumer probe was applied ${probeInstances.count} times in this process; exactly one live instance is required`);
  }
  const startedAt = new Date().toISOString();
  const profile = process.env.EVOLUTION_CROSS_ENTRY_PROFILE || 'web';
  const expected = parseJsonEnv('EVOLUTION_CROSS_ENTRY_EXPECT', {});
  const markers = parseJsonEnv('EVOLUTION_CROSS_ENTRY_MARKERS', {});
  const expectKernel = process.env.EVOLUTION_CROSS_ENTRY_EXPECT_KERNEL === '1';
  const dataRoot = dataRootFromEnvironment();
  const indexPath = path.join(dataRoot, 'shared-plugins', 'published.json');
  const statePath = path.join(dataRoot, 'shared-plugins', 'consumers', `${profile}.json`);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(predicate, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}${last === false ? '' : ''}`);
  }

  // Identify THIS boot's activation record. The consumer writes its state
  // during its own apply, which may finish before this probe starts (the ACP
  // entry boots its tree before the probe's deferred run) and the previous
  // entry's disposal rewrites the same file. The runner therefore passes the
  // wall-clock instant just before the entry was spawned: a record written by
  // this boot is strictly newer than it. The baseline snapshot is the fallback
  // for a caller that does not pass it.
  const baselineState = readJsonFile(statePath);
  const baselineUpdatedAt = typeof baselineState?.updatedAt === 'string' ? baselineState.updatedAt : null;
  const bootAfter = typeof process.env.EVOLUTION_CROSS_ENTRY_BOOT_AFTER === 'string'
    ? process.env.EVOLUTION_CROSS_ENTRY_BOOT_AFTER
    : null;
  const state = await waitFor(() => {
    const read = readJsonFile(statePath);
    if (read.status !== 'ok') return null;
    const value = read.value;
    if (typeof value?.updatedAt !== 'string') return null;
    const current = bootAfter !== null ? value.updatedAt > bootAfter : (baselineUpdatedAt === null || value.updatedAt !== baselineUpdatedAt);
    if (!current) return null;
    const rows = Array.isArray(value.plugins) ? value.plugins : [];
    if (Object.keys(expected).some((id) => !rows.some((row) => row?.id === id))) return null;
    return value;
  }, `consumer state ${statePath} for this boot`);

  const index = readJsonFile(indexPath);
  if (index.status !== 'ok') throw new Error(`the publication index is ${index.status} (${index.error || indexPath})`);
  const records = Array.isArray(index.value?.plugins) ? index.value.plugins : [];
  const indexUpdatedAt = typeof index.value?.updatedAt === 'string' ? index.value.updatedAt : null;
  if (!indexUpdatedAt) throw new Error('the publication index has no updatedAt');

  const evolutionTools = ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).length;
  const evolutionToolNames = ctx.tools.schemas().map((tool) => tool.name).filter((name) => name.startsWith('evolution_'));
  const kernelOnlyTools = evolutionToolNames.filter((name) => KERNEL_ONLY_TOOLS.includes(name));
  const allowedCoordinationTools = COORDINATION_TOOLS[profile] ?? [];
  const unexpectedEvolutionTools = evolutionToolNames.filter((name) => !KERNEL_ONLY_TOOLS.includes(name)
    && name !== SHARED_EXPERIENCE_TOOL
    && !allowedCoordinationTools.includes(name));
  const kernelPresent = Boolean(ctx.get('evolution'));
  if (expectKernel) {
    if (!kernelPresent) throw new Error('the full-kernel boot unexpectedly has no evolution service');
    if (evolutionToolNames.length !== EVOLUTION_TOOL_COUNT) throw new Error(`the full-kernel boot registered ${evolutionToolNames.length} evolution_* tools, expected ${EVOLUTION_TOOL_COUNT}`);
    if (kernelOnlyTools.length !== KERNEL_ONLY_TOOLS.length) throw new Error(`the full-kernel boot did not register the kernel tool surface: ${JSON.stringify(evolutionToolNames)}`);
  } else {
    if (kernelPresent) throw new Error('the consumer-only boot still has the Evolution kernel mounted');
    // The kernel is absent iff its service is absent and none of its
    // orchestrator-only tools are registered. `evolution_history` is allowed:
    // it is the shared-experience read tool, enabled by the product profile
    // setup in every entry, not part of the kernel.
    if (kernelOnlyTools.length !== 0) throw new Error(`the consumer-only boot registered kernel tools: ${JSON.stringify(kernelOnlyTools)}`);
    if (unexpectedEvolutionTools.length !== 0) throw new Error(`the consumer-only boot registered unexpected evolution_* tools: ${JSON.stringify(unexpectedEvolutionTools)}`);
  }

  const listenerCount = (name) => {
    const hooks = ctx.events?._hooks?.[name];
    return Array.isArray(hooks) ? hooks.length : 0;
  };
  const hasListener = (name) => listenerCount(name) > 0;

  const rows = new Map((state.plugins || []).map((row) => [row?.id, row]));
  const observed = [];
  const markerHits = {};
  const markerListeners = {};
  for (const [pluginId, expectation] of Object.entries(expected)) {
    const row = rows.get(pluginId);
    if (!row) throw new Error(`the consumer state has no row for ${pluginId}`);
    const want = typeof expectation === 'string' ? { status: expectation } : expectation;
    if (row.status !== want.status) {
      throw new Error(`the consumer state row ${pluginId} is ${row.status}, expected ${want.status} (reason=${row.reason ?? 'none'})`);
    }
    if (want.reason && row.reason !== want.reason) {
      throw new Error(`the consumer state row ${pluginId} has reason ${row.reason ?? 'none'}, expected ${want.reason}`);
    }
    observed.push({
      id: pluginId,
      status: row.status,
      reason: row.reason ?? null,
      activatedAt: row.activatedAt ?? null,
      sourceSha256: row.sourceSha256 ?? null,
      hostDigest: row.hostDigest ?? null,
    });
    const marker = markers[pluginId];
    if (!marker) continue;
    if (want.expectListener === true) {
      // The kernel mounted this record; the consumer must not mount a second
      // copy, so the listener still executes exactly once.
      await waitFor(() => hasListener(marker), `the kernel-mounted listener ${marker} of ${pluginId}`);
      markerListeners[pluginId] = listenerCount(marker);
      if (markerListeners[pluginId] !== 1) throw new Error(`the kernel-mounted record ${pluginId} registered ${markerListeners[pluginId]} listener(s) for ${marker}, expected exactly one`);
      const payload = { hits: 0 };
      await ctx.parallel(marker, payload);
      if (payload.hits !== 1) throw new Error(`the kernel-mounted listener ${marker} executed ${payload.hits} times, expected exactly once`);
      markerHits[pluginId] = payload.hits;
      continue;
    }
    if (want.status !== 'active') {
      // A skipped/disabled/revoked record must not be mounted at all: its
      // listener may not exist. (The record's own module is still importable,
      // which is why the status alone is not the proof.)
      markerListeners[pluginId] = listenerCount(marker);
      if (markerListeners[pluginId] !== 0) throw new Error(`the ${want.status} record ${pluginId} is still registered (${markerListeners[pluginId]} listener(s))`);
      markerHits[pluginId] = 0;
      continue;
    }
    await waitFor(() => hasListener(marker), `the promoted listener ${marker} of ${pluginId}`);
    markerListeners[pluginId] = listenerCount(marker);
    if (markerListeners[pluginId] !== 1) throw new Error(`the promoted record ${pluginId} registered ${markerListeners[pluginId]} listener(s) for ${marker}, expected exactly one`);
    const payload = { hits: 0 };
    await ctx.parallel(marker, payload);
    if (payload.hits !== 1) throw new Error(`the promoted listener ${marker} executed ${payload.hits} times, expected exactly once`);
    markerHits[pluginId] = payload.hits;
  }

  if (state.observedIndexUpdatedAt !== indexUpdatedAt) {
    throw new Error(`the consumer observed index ${state.observedIndexUpdatedAt}, the live index is ${indexUpdatedAt}`);
  }

  return {
    profile,
    dataRoot,
    indexPath,
    statePath,
    startedAt,
    consumerStateUpdatedAt: state.updatedAt,
    observedIndexUpdatedAt: state.observedIndexUpdatedAt,
    indexUpdatedAt,
    indexDigest: fs.existsSync(indexPath) ? crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex') : null,
    publishedIds: records.map((row) => row?.id),
    kernelPresent,
    evolutionTools,
    evolutionToolNames,
    kernelOnlyTools,
    // How many live probe instances this process composed (1 on every known
    // entry; >1 would mean the patch was composed into several contexts).
    probeInstances: probeInstances.count,
    // The actual consumer runtime, so the runner can record its versions.
    processVersions: {
      node: process.versions?.node ?? null,
      electron: process.versions?.electron ?? null,
      chrome: process.versions?.chrome ?? null,
    },
    expectKernel,
    services: {
      evolution: Boolean(ctx.get('evolution')),
      dynamicCordisRunner: Boolean(ctx.get('dynamicCordisRunner')),
      tools: Boolean(ctx.get('tools')),
      evolutionExperience: Boolean(ctx.get('evolutionExperience')),
    },
    rows: observed,
    markerHits,
    markerListeners,
    // The same facts the runner asserts independently from the JSON files.
    consumerRows: (state.plugins || []).map((row) => ({ id: row?.id, status: row?.status, reason: row?.reason ?? null, activatedAt: row?.activatedAt ?? null })),
  };
}
