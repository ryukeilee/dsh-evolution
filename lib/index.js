import { Service, Context } from '@deepseek-ai/cordis';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { apply as registerOrchestrator, warnRedacted } from './registration.js';
import { mountPromotedInclude } from './promotion-include.js';
import { recoverInterruptedPromotion } from './orchestrator.js';
import { openDomainStorage } from './domain-storage.js';
import { resolveEvolutionPaths, runDiagnostics } from './diagnostics.js';
import { registerIsolateKey } from './cordis-compat.js';

// The bundle entry is loaded by the host, where `@deepseek-ai/cordis` resolves,
// so hand the authoritative isolation-map symbol to lib/cordis-compat.js. The
// doctor CLI never loads this module and uses the registered-symbol fallback.
registerIsolateKey(Context.isolate);

export const name = 'dsh-evolution';
export const inject = ['tools', 'dynamicCordisRunner', 'systemPrompt', 'loader', 'storageDomain'];

/**
 * Resolve every path the bundle uses and initialize the event-bridge key.
 * Path resolution is shared with lib/diagnostics.js so the doctor can never
 * disagree with the runtime about where state lives.
 */
export function storageConfig(config = {}) {
  const paths = resolveEvolutionPaths({ dshHome: config.dshHome, dataRoot: config.dataRoot });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  // The key is written by the first run and never replaced, and the check below
  // refuses any file that is not 64 hex characters - it must, because replacing
  // a key invalidates every MAC already written with it. That makes a
  // half-written key file permanent: every later session would refuse to start.
  // `wx` cannot be undone after the fact, so creation is split out and the entry
  // is removed by the only call that can prove it created it. `EEXIST` is the
  // one error that proves nothing was created, so a key an earlier run wrote is
  // never touched, and every other failure with no entry created removes nothing.
  // Only a failed *write* removes it: once the bytes are on disk the key is
  // valid, and a session that read it in the meantime must not lose it because
  // this call's descriptor did not close.
  let created = false;
  let wrote = false;
  try {
    const descriptor = fs.openSync(paths.keyPath, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(descriptor, randomBytes(32).toString('hex'));
      wrote = true;
    } catch (error) {
      // The failed write is why the key is unusable, so it stays the error the
      // caller sees even if closing the descriptor also fails.
      try { fs.closeSync(descriptor); } catch {}
      throw error;
    }
    fs.closeSync(descriptor);
  } catch (error) {
    if (created && !wrote) { try { fs.rmSync(paths.keyPath, { force: true }); } catch {} }
    if (error.code !== 'EEXIST') throw error;
  }
  const eventBridgeKey = fs.readFileSync(paths.keyPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(eventBridgeKey)) throw new Error('Evolution event bridge key is invalid; refusing to replace it');
  return {
    ...config,
    ...paths,
    eventBridgeKey,
    startupDrift: false,
    promotionAdapter: 'official-include',
  };
}

class EvolutionService extends Service {
  constructor(ctx, orchestrator, config) {
    super(ctx, 'evolution');
    this.orchestrator = orchestrator;
    this.dataRoot = config.presetDir;
  }

  /** Model-free diagnostics over the live context; never mutates unless repair is requested. */
  diagnose(options = {}) {
    return this.orchestrator.diagnose(options);
  }
}

export async function apply(ctx, config = {}) {
  const resolved = storageConfig(config);
  resolved.domainStorage = await openDomainStorage(ctx, resolved);
  // Recover interrupted disk transactions BEFORE Include loads any children.
  await recoverInterruptedPromotion(resolved);
  resolved.promotionRuntime = await mountPromotedInclude(ctx, resolved);
  const diagnosisPaths = resolveEvolutionPaths({ dshHome: resolved.dshHome, dataRoot: resolved.presetDir });
  // The official profile context names the booted profile; using it makes the
  // in-session report cover the installed version and the composed loader tree
  // without requiring an environment variable.
  const diagnosisProfile = config.profile || process.env.DSH_PROFILE || (typeof ctx.get === 'function' ? ctx.get('profileContext')?.name : undefined) || null;
  resolved.diagnose = (options = {}) => runDiagnostics({
    paths: diagnosisPaths,
    dshHome: resolved.dshHome,
    home: true,
    profile: diagnosisProfile,
    profileDir: diagnosisProfile ? path.join(resolved.dshHome, 'profiles', diagnosisProfile) : null,
    cliPath: options.cliPath,
    runningEntry: process.argv[1] || null,
    probe: options.composition === false ? { skipComposition: true } : undefined,
    ctx,
    live: true,
    promotionRuntime: resolved.promotionRuntime,
    domainStorage: resolved.domainStorage,
    config: resolved,
    repair: options.repair === true,
    registeredNames: options.registeredNames,
  });
  // The official runner lazily retains its empty cordis-dynamic host group.
  // Initialize it through PUBLIC define/run/stop/undefine before capturing the
  // first experiment baseline, never by invoking its private ensureGroup().
  let preparation;
  resolved.prepareRuntime = (agent, signal) => {
    if (preparation) return preparation;
    preparation = (async () => {
      const runner = ctx.dynamicCordisRunner;
      const defined = runner.define({ sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'evo' },
        name: 'Evolution runtime preparation', purpose: 'Initialize official shared dynamic host infrastructure before baseline capture',
        code: { host: 'return { name: "evolution-runtime-prepare", apply() {} };' } });
      // `undefine` is cleanup of the preparation plugin and must always run, but
      // its own failure must not replace the reason the preparation failed: the
      // caller gets the primary error and the operator gets the cleanup failure
      // as a redacted diagnostic. A plugin left defined is a fact, not a reason
      // to hide the original cause. When the preparation itself succeeded, a
      // failed cleanup is still the one and only error to report.
      let failed = false;
      try {
        const started = await runner.run(agent, defined.pluginId, defined.packageId, 'run', signal);
        if (!started.ok) throw new Error(started.message || 'Evolution runtime preparation failed');
        const stopped = await runner.stop(agent, defined.pluginId);
        if (!stopped.ok) throw new Error('Evolution runtime preparation did not stop');
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        // A separate flag, never the thrown value itself: `throw undefined` (or
        // null, false, 0, '') is a legal rejection, and testing the value's
        // truthiness would read that cleanup failure as success, cache a
        // preparation whose plugin is still defined and never report it. The
        // original thrown value is kept and rethrown as-is when the preparation
        // itself succeeded.
        let cleanupFailed = false;
        let cleanupError;
        try {
          const removed = await runner.undefine(agent, defined.pluginId);
          if (!removed.ok) {
            cleanupFailed = true;
            cleanupError = new Error('Evolution runtime preparation did not undefine');
          }
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }
        if (cleanupFailed) {
          if (!failed) throw cleanupError;
          warnRedacted(ctx, "runtime preparation undefine failed", cleanupError, "cleanup");
        }
      }
    })().catch(error => { preparation = undefined; throw error; });
    return preparation;
  };
  const orchestrator = registerOrchestrator(ctx, resolved);
  new EvolutionService(ctx, orchestrator, resolved);
}
