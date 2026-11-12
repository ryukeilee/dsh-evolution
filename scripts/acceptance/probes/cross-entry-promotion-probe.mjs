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
 *   6. the `review-*` phases call the registered `evolution_plan` tool in this
 *      real kernel and report the unified self-evolution review. The probe
 *      snapshots the publication index bytes immediately before and after that
 *      tool call, so "read-only" is observed instead of trusted from the
 *      review's own `readOnly` flag (which is also asserted).
 *
 * The candidate plugins are real standalone Cordis plugins. The listeners are
 * executed by this probe (`ctx.parallel`) so "promoted and published" is proven
 * by behaviour, not by a file existing.
 *
 * Environment:
 *   EVOLUTION_CROSS_ENTRY_PHASE  `publish` (default) or `review-<suffix>`; any
 *                                other value is refused.
 */
import crypto from 'node:crypto';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const inject = ['evolution', 'agents', 'tools'];

/** The profiles the operator explicitly approves in this acceptance run. */
const TARGET_PROFILES = ['acp', 'web'];

/** Default marker event names; the consumer probe executes the same names. The
 *  local three-entry runner overrides them with a per-run namespace through
 *  `EVOLUTION_CROSS_ENTRY_MARKERS`, so a previously promoted plugin in a
 *  persisted `$DSH_HOME` can never share an event name with this run's
 *  candidates. */
export const MARKERS = Object.freeze({
  stable: 'cross-entry/probe/stable',
  desktopOnly: 'cross-entry/probe/desktop-only',
  incompatible: 'cross-entry/probe/incompatible',
  loadFailure: 'cross-entry/probe/load-failure',
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const expectedRecordId = (experimentId) => `evolution-promoted-${sha256(experimentId).slice(0, 12)}`;

/**
 * Resolve the marker vocabulary for this process.
 *
 * The host acceptance uses the fixed defaults (one boot per probe process); the
 * local runner passes a fresh namespace per run so the markers cannot collide
 * with a plugin promoted by an earlier run of the same isolated home. Every
 * key is required and the names must be distinct, so a typo cannot silently
 * make two candidates observe the same event.
 */
export function resolveMarkers(env = process.env) {
  const raw = env?.EVOLUTION_CROSS_ENTRY_MARKERS;
  if (typeof raw !== 'string' || raw.trim() === '') return { ...MARKERS };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`EVOLUTION_CROSS_ENTRY_MARKERS is not valid JSON: ${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('EVOLUTION_CROSS_ENTRY_MARKERS must be a JSON object');
  const markers = {};
  for (const key of Object.keys(MARKERS)) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`EVOLUTION_CROSS_ENTRY_MARKERS.${key} must be a non-empty string`);
    markers[key] = value;
  }
  if (new Set(Object.values(markers)).size !== Object.keys(markers).length) {
    throw new Error('EVOLUTION_CROSS_ENTRY_MARKERS must use distinct event names');
  }
  return markers;
}

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
    report(runCrossEntryPhase(ctx));
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
    const timer = setTimeout(() => report(runCrossEntryPhase(ctx)), 1500);
    ctx.effect(() => () => clearTimeout(timer));
  }
  // A file-receipt entry (Desktop, ACP) owns no IPC channel: `process.send` there
  // would inject a foreign message into the host's own parent/child protocol.
  if (!output) process.send?.({ ready: true });
}

/**
 * Resolve the phase this probe process must run.
 *
 * The promotion path keeps the historical `publish` phase. A `review-<suffix>`
 * phase reads the same durable state and returns the unified review; the suffix
 * is only an evidence label and never changes the query.
 */
export function resolveCrossEntryPhase(env = process.env) {
  const phase = typeof env?.EVOLUTION_CROSS_ENTRY_PHASE === 'string' && env.EVOLUTION_CROSS_ENTRY_PHASE.trim() !== ''
    ? env.EVOLUTION_CROSS_ENTRY_PHASE.trim()
    : 'publish';
  if (phase !== 'publish' && !/^review(?:-[a-z0-9]+)*$/.test(phase)) {
    throw new Error(`unknown cross-entry phase ${phase}`);
  }
  return phase;
}

/** Run the phase this process was booted for (promotion or a read-only review). */
export function runCrossEntryPhase(ctx) {
  const phase = resolveCrossEntryPhase();
  return phase === 'publish'
    ? runCrossEntryPublish(ctx)
    : runCrossEntryReview(ctx, { phase });
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
  const markers = resolveMarkers();

  const hasListener = (name) => {
    const hooks = ctx.events?._hooks?.[name];
    return Array.isArray(hooks) && hooks.length > 0;
  };
  /** Number of live Cordis listeners for one event name (0 when none). */
  const listenerCount = (name) => {
    const hooks = ctx.events?._hooks?.[name];
    return Array.isArray(hooks) ? hooks.length : 0;
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
    // The trial plugin must be the only listener for this run-unique event
    // name. A pre-existing listener means the home is not clean for this run
    // (for example a plugin promoted by an earlier run of the same home); that
    // is an ambiguous environment, not a duplicate activation, and must fail
    // loudly instead of producing mixed evidence.
    const listenersBefore = listenerCount(name);
    if (listenersBefore !== 1) {
      throw new Error(`the marker ${name} has ${listenersBefore} listener(s) before execution, expected exactly one; the isolated DSH_HOME is not clean for this run`);
    }
    await ctx.parallel(name, payload);
    const listenersAfter = listenerCount(name);
    if (listenersAfter !== 1) throw new Error(`the marker ${name} has ${listenersAfter} listener(s) after execution, expected exactly one`);
    if (payload.hits !== 1) throw new Error(`the promoted listener ${name} was not executed exactly once (hits=${payload.hits})`);
    steps.push({ name: `event:${name}`, ok: true, listeners: listenersAfter, hits: payload.hits });
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
    // The run-unique marker must be unheard before this candidate's trial:
    // exactly one listener must appear after the trial registered it.
    const listenersBeforeTrial = listenerCount(marker);
    if (listenersBeforeTrial !== 0) {
      throw new Error(`the marker ${marker} already has ${listenersBeforeTrial} listener(s) before its trial; use a fresh isolated DSH_HOME or a new marker namespace`);
    }
    await call('evolution_trial', {
      experimentId,
      composition: { name: pluginName, purpose: label, code: { host: hostCode } },
    });
    const listenersAfterTrial = listenerCount(marker);
    if (listenersAfterTrial !== 1) {
      throw new Error(`the trial plugin registered ${listenersAfterTrial} listener(s) for ${marker}, expected exactly one`);
    }
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
    return { experimentId, expectedId: expectedRecordId(experimentId), pluginName, marker, label, suffix, trialHits, listenersAfterTrial };
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
  async function commitStable({ experimentId, suffix }, { assertNotPublished } = {}) {
    const firstObservation = await observeCanary(experimentId, `cross-entry-${suffix}-1`);
    if (firstObservation.stable === true) {
      throw new Error('the canary window completed after one observation; the acceptance expected the default window');
    }
    // The barrier must hold for the whole window, not only before the first
    // observation: a publication that happens while the window is still open is
    // a real leak even if the first observation reports `stable: false`.
    if (assertNotPublished) await assertNotPublished('the plugin was published while the canary window was still open');
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
    const publishedAtConfirmationGate = (await readIndex()).plugins.some((row) => row?.id === expectedId);
    if (publishedAtConfirmationGate) {
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
    const publishedBeforeCanaryCommit = (await readIndex()).plugins.some((row) => row?.id === expectedId);
    if (publishedBeforeCanaryCommit) {
      throw new Error(`the plugin was published before the canary committed stable (${expectedId})`);
    }
    // (c) Two canary observations -> stable commit -> publication.
    let publishedAfterFirstObservation = false;
    const committed = await commitStable(candidate, {
      assertNotPublished: async (message) => {
        publishedAfterFirstObservation = (await readIndex()).plugins.some((row) => row?.id === expectedId);
        if (publishedAfterFirstObservation) throw new Error(`${message} (${expectedId})`);
      },
    });
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
      gates: { publishedAtConfirmationGate, publishedBeforeCanaryCommit, publishedAfterFirstObservation },
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
    const phase = 'publish';
    const extended = process.env.EVOLUTION_CROSS_ENTRY_EXTENDED === '1';
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
      // The runtime that produced the promotion, so the evidence names the
      // actual Desktop Electron/Node versions instead of the runner's.
      hostRuntime: {
        node: process.versions?.node ?? null,
        electron: process.versions?.electron ?? null,
        chrome: process.versions?.chrome ?? null,
        v8: process.versions?.v8 ?? null,
      },
      extended,
      markers,
      steps,
      candidates: {},
    };
    // 1. explicit cross-entry approval: the consumer must mount it.
    output.candidates.stable = await publishShared(await prepareCandidate({
      suffix: 'stable',
      marker: markers.stable,
      label: 'a standalone host-only plugin that registers an observable cross-entry marker',
      hostCode: `return { name: 'cross_entry_probe_stable', apply(ctx) { ctx.on(${JSON.stringify(markers.stable)}, (payload) => { payload.hits += 1; }); } };`,
    }));
    // 2. Desktop-only control: a stable commit without deployment approval.
    output.candidates.desktopOnly = await desktopOnlyControl(await prepareCandidate({
      suffix: 'desktop-only',
      marker: markers.desktopOnly,
      label: 'a standalone host-only plugin promoted without cross-entry approval',
      hostCode: `return { name: 'cross_entry_probe_desktop_only', apply(ctx) { ctx.on(${JSON.stringify(markers.desktopOnly)}, (payload) => { payload.hits += 1; }); } };`,
    }));
    // 3. a plugin that requires the kernel service: present in this publisher
    //    entry, absent in a consumer-only entry, so the consumer must skip it as
    //    incompatible without affecting the first plugin.
    output.candidates.incompatible = await publishShared(await prepareCandidate({
      suffix: 'incompatible',
      marker: markers.incompatible,
      label: 'a standalone host-only plugin that requires the kernel-only evolution service',
      hostCode: `return { name: 'cross_entry_probe_incompatible', inject: ['evolution'], apply(ctx) { ctx.on(${JSON.stringify(markers.incompatible)}, (payload) => { payload.hits += 1; }); } };`,
    }));
    if (!output.candidates.incompatible.requiredServices.includes('evolution')) {
      throw new Error(`the incompatible record does not require the kernel service: ${JSON.stringify(output.candidates.incompatible.requiredServices)}`);
    }
    // 4. Extended mode only: a published plugin whose apply() succeeds in the
    //    publisher (the kernel service exists) but throws in a consumer-only
    //    entry. The consumer must isolate it as `failed` without affecting the
    //    other records; this is a real load failure, not a synthetic status.
    if (extended) {
      output.candidates.loadFailure = await publishShared(await prepareCandidate({
        suffix: 'load-failure',
        marker: markers.loadFailure,
        label: 'a standalone host-only plugin that loads only where the kernel service exists',
        hostCode: `return { name: 'cross_entry_probe_load_failure', apply(ctx) { if (!ctx.get('evolution')) throw new Error('simulated consumer-side apply failure'); ctx.on(${JSON.stringify(markers.loadFailure)}, (payload) => { payload.hits += 1; }); } };`,
      }));
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

/**
 * The read-only phase: call the registered `evolution_plan` tool in this real
 * kernel and prove the unified review wrote nothing.
 *
 * The publication index bytes are captured immediately before the tool call and
 * compared immediately after it. The durable review reads the index, the
 * promoted sources, the consumer state and the revocations through
 * `promoted-sharing.js`, so any write on that path fails here. The tool is
 * reached through `ctx.tools.get` exactly as a model request would reach it.
 */
export async function runCrossEntryReview(ctx, { phase = 'review' } = {}) {
  const evolution = ctx.get('evolution');
  const orchestrator = evolution?.orchestrator;
  if (!orchestrator) throw new Error('the cross-entry review probe requires the full Evolution kernel');
  const dataRoot = evolution.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot === '') throw new Error('the Evolution service did not expose its data root');
  const indexPath = path.join(dataRoot, 'shared-plugins', 'published.json');
  const before = await fs.readFile(indexPath);
  const handle = await ctx.agents.create({
    sessionId: `cross-entry-review-${Date.now()}`,
    meta: { cwd: process.env.EVOLUTION_ACCEPTANCE_CWD || process.cwd() },
  });
  const steps = [];
  try {
    const agent = handle.agent;
    const definition = ctx.tools.get('evolution_plan', agent);
    if (!definition) throw new Error('the official registry cannot resolve evolution_plan');
    const result = await definition.execute({}, { agent, signal: new AbortController().signal });
    steps.push({ name: 'evolution_plan', ok: result?.ok !== false });
    if (result?.ok === false) {
      throw new Error(`evolution_plan refused: ${JSON.stringify({ phase: result?.phase, reason: result?.reason })}`);
    }
    const stablePlugins = result?.stablePlugins ?? null;
    const selfEvolution = result?.selfEvolution ?? null;
    if (!stablePlugins || typeof stablePlugins !== 'object' || Array.isArray(stablePlugins)) {
      throw new Error('the review result has no stablePlugins document');
    }
    if (!selfEvolution || typeof selfEvolution !== 'object' || Array.isArray(selfEvolution)) {
      throw new Error('the review result has no selfEvolution decision');
    }
    if (stablePlugins.readOnly !== true || selfEvolution.readOnly !== true) {
      throw new Error('the review result does not declare itself read-only');
    }
    const after = await fs.readFile(indexPath);
    if (!before.equals(after)) {
      throw new Error(`the self-evolution review changed the publication index bytes (${sha256(before)} -> ${sha256(after)})`);
    }
    let indexUpdatedAt = null;
    try { indexUpdatedAt = JSON.parse(after.toString('utf8'))?.updatedAt ?? null; } catch { indexUpdatedAt = null; }
    return {
      phase,
      dataRoot,
      indexPath,
      tools: ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).length,
      hostRuntime: {
        node: process.versions?.node ?? null,
        electron: process.versions?.electron ?? null,
        chrome: process.versions?.chrome ?? null,
        v8: process.versions?.v8 ?? null,
      },
      steps,
      review: { stablePlugins, selfEvolution },
      index: { status: 'ok', digest: sha256(before), digestAfter: sha256(after), updatedAt: indexUpdatedAt },
    };
  } finally {
    await handle.dispose();
  }
}
