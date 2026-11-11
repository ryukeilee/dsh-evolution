/**
 * Acceptance probe: publish a verified stable promotion to the cross-entry
 * shared index from a full Evolution-kernel entry (Desktop or the Web profile
 * booted with the kernel), then report exactly what the consumers will read.
 *
 * Run commands (the caller sets these; the probe itself takes no arguments):
 *   - host acceptance: booted on `--profile web` with the full bundle patch and
 *     driven through `process.send('run')` (see run-host-acceptance.mjs
 *     `bootProbe`), with `EVOLUTION_CROSS_ENTRY_PHASE=publish`.
 *   - Desktop evidence: inserted into the desktop profile patch and driven by a
 *     file receipt, with `EVOLUTION_ENTRY_PROBE_OUT=<file>` (see
 *     scripts/acceptance/run-cross-entry.mjs).
 *
 * What it proves, through the official tool registry only:
 *   1. the confirmation gate alone (no `targetProfiles`) publishes nothing;
 *   2. a promotion with `confirmation: true, targetProfiles: ['acp','web']`
 *      is durable at the canary barrier but is NOT published while the canary
 *      window is still open;
 *   3. after the canary commits stable, exactly one published record exists for
 *      the experiment with the stable proof, the approved profiles and the
 *      source digest, and the plugin's listener is executable;
 *   4. a Desktop-only control promotion (confirmation without targetProfiles)
 *      commits stable but is never published;
 *   5. a second plugin that requires a kernel-only service is published too (its
 *      `requiredServices` is what a consumer uses to skip it as incompatible).
 *
 * The candidate plugins are real standalone Cordis plugins. The listeners are
 * executed by this probe (`ctx.parallel`) so "promoted and published" is proven
 * by behaviour, not by a file existing.
 */
import crypto from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const inject = ['evolution', 'agents', 'tools'];

/** The profiles the operator explicitly approves in this acceptance run. */
const TARGET_PROFILES = ['acp', 'web'];

/** Marker event names; the consumer probe executes the same names. */
export const MARKERS = Object.freeze({
  stable: 'cross-entry/probe/stable',
  desktopOnly: 'cross-entry/probe/desktop-only',
  incompatible: 'cross-entry/probe/incompatible',
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const expectedRecordId = (experimentId) => `evolution-promoted-${sha256(experimentId).slice(0, 12)}`;

export function apply(ctx) {
  const output = process.env.EVOLUTION_ENTRY_PROBE_OUT;
  const report = (promise) => {
    void promise.then(
      (result) => {
        if (output) return writeFileSync(output, `${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        process.send?.({ result });
        return undefined;
      },
      (error) => {
        const payload = { ok: false, error: `${String(error?.stack || error)}`.slice(0, 4000) };
        if (output) return writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
        process.send?.({ error: payload.error });
        return undefined;
      },
    );
  };
  const receive = (message) => {
    if (output || message !== 'run') return;
    report(runCrossEntryPublish(ctx));
  };
  if (!output) {
    ctx.effect(() => {
      process.on('message', receive);
      return () => process.off('message', receive);
    });
  }
  if (output) {
    // A file-receipt entry (Desktop) has no IPC channel: run once the profile
    // tree has settled instead of when a message arrives. The Desktop host can
    // compose the same profile patch into more than one live context in one
    // process, which would load this probe twice; a `wx` lock makes exactly one
    // instance the driver (a duplicate driver would register the trial listener
    // twice and make every marker execution ambiguous).
    let driver = false;
    try {
      closeSync(openSync(`${output}.lock`, 'wx', 0o600));
      driver = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (!driver) return;
    const timer = setTimeout(() => report(runCrossEntryPublish(ctx)), 1500);
    ctx.effect(() => () => clearTimeout(timer));
  }
  // A file-receipt entry (Desktop, ACP) owns no IPC channel: `process.send` there
  // would inject a foreign message into the host's own parent/child protocol.
  if (!output) process.send?.({ ready: true });
}

/**
 * The probe body. Exported so a thin Desktop probe can reuse it, and so the
 * host-acceptance runner keeps one implementation of the publish flow.
 */
export async function runCrossEntryPublish(ctx, onStep = () => {}) {
  const evolution = ctx.get('evolution');
  const orchestrator = evolution?.orchestrator;
  if (!orchestrator) throw new Error('the cross-entry publish probe requires the full Evolution kernel');
  const dataRoot = evolution.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot === '') throw new Error('the Evolution service did not expose its data root');

  const hasListener = (name) => {
    const hooks = ctx.events?._hooks?.[name];
    return Array.isArray(hooks) && hooks.length > 0;
  };

  const indexPath = path.join(dataRoot, 'shared-plugins', 'published.json');
  async function readIndex() {
    try {
      const bytes = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(bytes);
      return { status: 'ok', index: parsed, digest: sha256(bytes), plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [] };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'absent', index: null, digest: null, plugins: [] };
      throw new Error(`the published index is unreadable: ${error?.code || error?.message || error}`);
    }
  }

  const handle = await ctx.agents.create({
    sessionId: `cross-entry-publish-${Date.now()}`,
    meta: { cwd: process.env.EVOLUTION_ACCEPTANCE_CWD || process.cwd() },
  });
  const agent = handle.agent;
  const steps = [];
  const call = async (name, args, expectedFailure = false) => {
    onStep(name);
    const definition = ctx.tools.get(name, agent);
    if (!definition) throw new Error(`the official registry cannot resolve ${name}`);
    const result = await definition.execute(args, { agent, signal: new AbortController().signal });
    steps.push({ name, ok: result?.ok !== false, phase: result?.phase, stable: result?.stable });
    if (!expectedFailure && result?.ok === false) {
      throw new Error(`${name} refused: ${JSON.stringify({ phase: result?.phase, reason: result?.reason, runtimeRecovered: result?.runtimeRecovered })}`);
    }
    return result;
  };
  const executeMarker = async (name) => {
    const payload = { hits: 0 };
    await ctx.parallel(name, payload);
    if (payload.hits !== 1) throw new Error(`the promoted listener ${name} was not executed exactly once (hits=${payload.hits})`);
    steps.push({ name: `event:${name}`, ok: true });
    return payload.hits;
  };

  /** Wait until the live runtime signature is stable; promotion captures a baseline. */
  async function waitForStableRuntime() {
    let previous = null;
    let stable = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && stable < 4) {
      const definition = ctx.tools.get('evolution_runtime_inspect', agent);
      if (!definition) throw new Error('the official registry cannot resolve evolution_runtime_inspect');
      const runtime = await definition.execute({}, { agent, signal: new AbortController().signal });
      const fingerprint = JSON.stringify({
        components: (runtime.components || []).map((entry) => `${entry.name}#${entry.uid}`).sort(),
        services: (runtime.services || []).map((entry) => `${entry.name}:${entry.active}`).sort(),
        events: (runtime.events || []).map((entry) => `${entry.name}:${(entry.listeners || []).length}`).sort(),
      });
      if (fingerprint === previous) stable += 1;
      else { stable = 0; previous = fingerprint; }
      if (stable < 4) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (stable < 4) throw new Error('the live runtime signature did not stabilize before promotion');
    steps.push({ name: 'runtime-stable', ok: true });
  }

  /**
   * propose -> trial -> measure. Shared by every candidate; the caller decides
   * whether the promotion carries cross-entry approval.
   */
  async function prepareCandidate({ suffix, marker, hostCode, label }) {
    const pluginName = `cross_entry_probe_${suffix}`;
    await waitForStableRuntime();
    const proposed = await call('evolution_propose', {
      why: `cross-entry acceptance: ${label}`,
      target: `plugin:${pluginName}`,
      impactScope: ['acceptance-only'],
      successMetrics: ['the plugin is mounted and executes in the ACP and Web consumer entries after a stable canary commit'],
    });
    const experimentId = proposed.experimentId;
    await call('evolution_trial', {
      experimentId,
      composition: { name: pluginName, purpose: label, code: { host: hostCode } },
    });
    if (!hasListener(marker)) throw new Error(`the trial listener ${marker} was not registered`);
    const trialHits = await executeMarker(marker);
    await call('evolution_measure', {
      experimentId,
      observation: {
        solvesProblem: true,
        metrics: { errors: 0 },
        beforeMetrics: { errors: 1 },
        afterMetrics: { errors: 0 },
        sampleCount: 2,
        observationWindow: 'trial registered an executable marker and the durable restart gate is pending',
        benefitEvidence: 'a real marker execution was recorded; the restart gate remains',
        repeatable: true,
        regressionPassed: true,
        reversible: true,
        cleanupEvidence: 'a real runner stop/undefine baseline comparison runs at promotion',
      },
    });
    return { experimentId, expectedId: expectedRecordId(experimentId), pluginName, marker, label, suffix, trialHits };
  }

  const observeCanary = (experimentId, barrier) => call('evolution_canary_observe', {
    experimentId,
    startupVerified: true,
    componentHealth: 'active',
    dependenciesPresent: true,
    metricRegression: false,
    barrier: { id: barrier, reached: true },
    evidence: { listenerExecuted: true },
  });

  /** Close the default two-observation canary window and assert the stable commit. */
  async function commitStable({ experimentId, suffix }) {
    const firstObservation = await observeCanary(experimentId, `cross-entry-${suffix}-1`);
    if (firstObservation.stable === true) {
      throw new Error('the canary window completed after one observation; the acceptance expected the default window');
    }
    const committed = await observeCanary(experimentId, `cross-entry-${suffix}-2`);
    if (committed.stable !== true) {
      throw new Error(`the canary did not commit stable: ${JSON.stringify({ phase: committed.phase, stable: committed.stable })}`);
    }
    return committed;
  }

  /** Candidate 1/3: explicit cross-entry approval, published only after stable. */
  async function publishShared(candidate) {
    const { experimentId, expectedId, marker, suffix } = candidate;
    // (a) The confirmation gate is read-only and must publish nothing.
    const gated = await call('evolution_promote', { experimentId }, true);
    if (gated.phase !== 'awaiting-owner-confirmation') {
      throw new Error(`the confirmation gate did not stop the promotion: ${JSON.stringify({ phase: gated.phase })}`);
    }
    if (!hasListener(marker)) throw new Error('the confirmation gate mutated the trial');
    if ((await readIndex()).plugins.some((row) => row?.id === expectedId)) {
      throw new Error(`the confirmation-gated promotion published ${expectedId} without cross-entry approval`);
    }
    // (b) Confirmed promotion with the explicit deployment scope.
    const promoted = await call('evolution_promote', { experimentId, confirmation: true, targetProfiles: TARGET_PROFILES });
    if (JSON.stringify(promoted.shareTargets) !== JSON.stringify(TARGET_PROFILES)) {
      throw new Error(`the promotion did not record the approved profiles: ${JSON.stringify(promoted.shareTargets)}`);
    }
    if (promoted.phase !== 'canary-observing') throw new Error(`the promotion did not reach the canary barrier: ${JSON.stringify({ phase: promoted.phase })}`);
    const promotedHits = await executeMarker(marker);
    // Still canary-observing: a consumer may only ever see a stable commit.
    if ((await readIndex()).plugins.some((row) => row?.id === expectedId)) {
      throw new Error(`the plugin was published before the canary committed stable (${expectedId})`);
    }
    // (c) Two canary observations -> stable commit -> publication.
    const committed = await commitStable(candidate);
    if (!['published', 'updated', 'unchanged'].includes(committed.shared?.status)) {
      throw new Error(`the stable commit did not publish a shared record: ${JSON.stringify(committed.shared)}`);
    }
    if (committed.shared.id !== expectedId) {
      throw new Error(`the published id ${committed.shared.id} does not match the committed identity ${expectedId}`);
    }
    const record = (await readIndex()).plugins.find((row) => row?.id === expectedId);
    if (!record) throw new Error(`the published index has no record ${expectedId}`);
    if (!Array.isArray(record.approvedProfiles) || record.approvedProfiles.length !== TARGET_PROFILES.length
      || record.approvedProfiles.some((profile) => !TARGET_PROFILES.includes(profile))) {
      throw new Error(`the published record does not carry the approved profiles: ${JSON.stringify(record.approvedProfiles)}`);
    }
    if (record.stable?.decision !== 'benefit' || record.stable?.canary?.startupVerified !== true || typeof record.stable?.committedAt !== 'string') {
      throw new Error(`the published record does not carry the stable proof: ${JSON.stringify(record.stable)}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(record.sourceSha256))) throw new Error('the published record carries no source digest');
    if (record.hostOnly !== true) throw new Error('the published record is not host-only');
    if (!record.host || typeof record.host.dsh !== 'string' || typeof record.host.cordis !== 'string' || typeof record.host.include !== 'string') {
      throw new Error(`the published record carries no verified host identity: ${JSON.stringify(record.host)}`);
    }
    return {
      experimentId,
      id: expectedId,
      // The durable promoted directory name, not the trial composition name.
      pluginName: record.pluginName,
      trialPluginName: candidate.pluginName,
      moduleUrl: record.moduleUrl,
      sourceSha256: record.sourceSha256,
      manifestSha256: record.manifestSha256,
      approvedProfiles: record.approvedProfiles,
      requiredServices: record.requiredServices,
      requiredCapabilities: record.requiredCapabilities,
      host: record.host,
      stable: record.stable,
      marker,
      hits: { trial: candidate.trialHits, promoted: promotedHits },
      sharedStatus: committed.shared.status,
    };
  }

  /**
   * Candidate 2/3: Desktop-only control. Confirmed production promotion without
   * `targetProfiles` commits stable but must never publish a record.
   */
  async function desktopOnlyControl(candidate) {
    const { experimentId, expectedId, marker } = candidate;
    const promoted = await call('evolution_promote', { experimentId, confirmation: true });
    if (Array.isArray(promoted.shareTargets) && promoted.shareTargets.length > 0) {
      throw new Error(`a Desktop-only promotion recorded deployment targets: ${JSON.stringify(promoted.shareTargets)}`);
    }
    if (promoted.phase !== 'canary-observing') throw new Error(`the Desktop-only promotion did not reach the canary barrier: ${JSON.stringify({ phase: promoted.phase })}`);
    const promotedHits = await executeMarker(marker);
    const committed = await commitStable({ ...candidate, suffix: 'desktop-only' });
    if (committed.shared?.status !== 'desktop-only') {
      throw new Error(`the Desktop-only stable commit did not report desktop-only: ${JSON.stringify(committed.shared)}`);
    }
    const record = (await readIndex()).plugins.find((row) => row?.id === expectedId);
    if (record) throw new Error(`the Desktop-only promotion was published as ${expectedId}`);
    return {
      experimentId,
      id: expectedId,
      // The promotion writes the durable plugin directory as
      // `dsh-evolution-promoted-<id suffix>`; the record is not published, so
      // derive it from the committed row id.
      pluginName: `dsh-evolution-promoted-${expectedId.slice('evolution-promoted-'.length)}`,
      trialPluginName: candidate.pluginName,
      marker,
      hits: { trial: candidate.trialHits, promoted: promotedHits },
      sharedStatus: committed.shared.status,
      published: false,
    };
  }

  try {
    const phase = process.env.EVOLUTION_CROSS_ENTRY_PHASE || 'publish';
    if (phase !== 'publish') throw new Error(`unknown cross-entry phase ${phase}`);
    const output = {
      phase,
      dataRoot,
      indexPath,
      tools: ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).length,
      // Recorded so the evidence shows why the incompatible case uses a
      // kernel-only service: `dynamicCordisRunner` is provided by the Web
      // composition even when the Evolution kernel row is disabled, so it is
      // not a Web-consumer-missing service (it is missing in ACP only).
      services: {
        evolution: Boolean(ctx.get('evolution')),
        dynamicCordisRunner: Boolean(ctx.get('dynamicCordisRunner')),
        tools: Boolean(ctx.get('tools')),
      },
      markers: { ...MARKERS },
      steps,
      candidates: {},
    };
    // 1. explicit cross-entry approval: the consumer must mount it.
    output.candidates.stable = await publishShared(await prepareCandidate({
      suffix: 'stable',
      marker: MARKERS.stable,
      label: 'a standalone host-only plugin that registers an observable cross-entry marker',
      hostCode: `return { name: 'cross_entry_probe_stable', apply(ctx) { ctx.on(${JSON.stringify(MARKERS.stable)}, (payload) => { payload.hits += 1; }); } };`,
    }));
    // 2. Desktop-only control: a stable commit without deployment approval.
    output.candidates.desktopOnly = await desktopOnlyControl(await prepareCandidate({
      suffix: 'desktop-only',
      marker: MARKERS.desktopOnly,
      label: 'a standalone host-only plugin promoted without cross-entry approval',
      hostCode: `return { name: 'cross_entry_probe_desktop_only', apply(ctx) { ctx.on(${JSON.stringify(MARKERS.desktopOnly)}, (payload) => { payload.hits += 1; }); } };`,
    }));
    // 3. a plugin that requires the kernel service: present in this publisher
    //    entry, absent in a consumer-only entry, so the consumer must skip it as
    //    incompatible without affecting the first plugin.
    output.candidates.incompatible = await publishShared(await prepareCandidate({
      suffix: 'incompatible',
      marker: MARKERS.incompatible,
      label: 'a standalone host-only plugin that requires the kernel-only evolution service',
      hostCode: `return { name: 'cross_entry_probe_incompatible', inject: ['evolution'], apply(ctx) { ctx.on(${JSON.stringify(MARKERS.incompatible)}, (payload) => { payload.hits += 1; }); } };`,
    }));
    if (!output.candidates.incompatible.requiredServices.includes('evolution')) {
      throw new Error(`the incompatible record does not require the kernel service: ${JSON.stringify(output.candidates.incompatible.requiredServices)}`);
    }
    const index = await readIndex();
    output.index = {
      status: index.status,
      updatedAt: index.index?.updatedAt ?? null,
      digest: index.digest,
      ids: index.plugins.map((row) => row?.id),
    };
    return output;
  } finally {
    await handle.dispose();
  }
}
