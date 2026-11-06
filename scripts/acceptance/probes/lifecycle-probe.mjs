/**
 * Acceptance probe: the official pluginManager enable/disable lifecycle.
 *
 * The probe asserts the live-vs-selected semantics itself: `applied` must
 * change the mounted service and the registered tool count immediately, while
 * `restart-required` must only change the saved selection. Evolution user data
 * must be byte-identical before and after every action.
 *
 * `restart-required` does not mean "the live tree did not change" in general:
 * the host reads the capability that decides a live application (`ctx.get('hmr')`)
 * more than once per call. `PluginManager.change()` snapshots it into
 * `application` before the profile write, while `configure()` and `reload()`
 * re-read it after that write to decide whether the change is applied live. The
 * HMR service becomes available only when its asynchronous init completes, so a
 * call that starts while the host is still starting up can straddle the
 * transition: the report is a snapshot older than the reload decision, and the
 * change is applied live even though the report says `restart-required`.
 *
 * The probe therefore records the capability immediately before and after the
 * call and derives the expected live tree from the capability the reload
 * decision used:
 *
 *   - capability unchanged across the call → the host read one value for the
 *     report and for the reload, so the report must match it exactly and the
 *     live tree must follow the report;
 *   - capability changed during the call → the report may be the older snapshot,
 *     so the outcome is ambiguous in exactly one direction per report value
 *     (see `outcomeIsAmbiguous` below); every other combination still has to
 *     reach the tree the report promises, and the switch must always be atomic
 *     (the service and the tool surface agree on one state).
 *
 * This is not a retry and adds no delay: the action is issued once, at the same
 * moment as before.
 *
 * With the `hmr` row disabled (the supported configuration for a host where a
 * profile change must wait for a restart) the capability is absent before and
 * after the call, so the report is never ambiguous: it must be
 * `restart-required` with `restartReason: 'no-hmr'`, and the live tree must stay
 * at the pre-call state until the harness restarts the host.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The tool surface the bundle registers (lib/registration.js#EVOLUTION_TOOLS). */
const EVOLUTION_TOOL_COUNT = 10;
/** The host service whose availability decides a live profile application. */
const LIVE_APPLY_SERVICE = 'hmr';

export const inject = ['pluginManager', 'tools'];

export function apply(ctx) {
  const receive = (message) => {
    if (message !== 'run') return;
    void run().then(
      (result) => process.send?.({ result }),
      (error) => process.send?.({ error: String(error.stack || error) }),
    );
  };
  ctx.effect(() => {
    process.on('message', receive);
    return () => process.off('message', receive);
  });
  process.send?.({ ready: true });

  const dataRoot = () => path.join(process.env.DSH_HOME, 'storages', 'evolution');
  const memoryPath = () => path.join(dataRoot(), 'evolution-memory.json');
  const memorySha = async () => crypto.createHash('sha256').update(await fs.readFile(memoryPath())).digest('hex');
  const names = () => ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).map((tool) => tool.name);
  const liveState = () => ({ mounted: Boolean(ctx.get('evolution')), tools: names().length });
  const format = (state) => `mounted=${state.mounted}, tools=${state.tools}`;
  /** Whether the host can apply a profile change to the live tree right now. */
  const liveApplyAvailable = () => ctx.get(LIVE_APPLY_SERVICE) !== undefined;

  async function run() {
    const action = process.env.EVOLUTION_LIFECYCLE_ACTION || 'verify';
    const expectMountedBefore = action !== 'enable' && action !== 'reinstall';
    const expectSelectedAfter = action !== 'disable' && action !== 'uninstall';

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (Boolean(ctx.get('evolution')) === expectMountedBefore && names().length === (expectMountedBefore ? EVOLUTION_TOOL_COUNT : 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const mountedBefore = Boolean(ctx.get('evolution'));
    if (mountedBefore !== expectMountedBefore || names().length !== (expectMountedBefore ? EVOLUTION_TOOL_COUNT : 0)) {
      throw new Error(`${action}: startup state wrong (${format(liveState())})`);
    }

    const before = await memorySha();
    const liveApplyBefore = liveApplyAvailable();
    let result = { application: 'applied', changed: false };
    if (action === 'disable') result = await ctx.pluginManager.setBundleEnabled('dsh-evolution', false);
    else if (action === 'enable') result = await ctx.pluginManager.setBundleEnabled('dsh-evolution', true);
    else if (action === 'verify') result = { application: 'applied', changed: false };
    else throw new Error(`unknown lifecycle action ${action}`);
    if (!['applied', 'restart-required'].includes(result.application)) throw new Error(`${action} failed: ${JSON.stringify(result)}`);
    const liveApplyAfter = liveApplyAvailable();

    const selected = (await ctx.pluginManager.listBundles()).some((bundle) => bundle.name === 'dsh-evolution' && bundle.enabled);
    if (selected !== expectSelectedAfter) throw new Error(`${action}: saved selection is ${selected}, expected ${expectSelectedAfter}`);

    const liveBefore = { mounted: expectMountedBefore, tools: expectMountedBefore ? EVOLUTION_TOOL_COUNT : 0 };
    const liveSelected = { mounted: expectSelectedAfter, tools: expectSelectedAfter ? EVOLUTION_TOOL_COUNT : 0 };
    const observed = liveState();
    const matches = (expected) => observed.mounted === expected.mounted && observed.tools === expected.tools;

    if (action === 'verify') {
      if (!matches(liveBefore)) throw new Error(`verify: live state is ${format(observed)}, expected ${format(liveBefore)}`);
    } else {
      // Only one combination per report value is ambiguous, because the report is
      // the *earlier* read: `applied` says the snapshot already saw live apply, so
      // the reload decision (read later, inside the operation body the host runs
      // either way) must have seen it too — unless the capability disappeared
      // during the call. `restart-required` says the snapshot did not see it, and
      // the reload may have seen it when the capability appeared during the call.
      const outcomeIsAmbiguous = result.application === 'applied'
        ? liveApplyBefore && !liveApplyAfter
        : !liveApplyBefore && liveApplyAfter;
      if (outcomeIsAmbiguous) {
        // The switch must still be all-or-nothing: the service and the tool
        // surface agree on the pre-call state or on the selected one.
        if (!matches(liveBefore) && !matches(liveSelected)) {
          throw new Error(`${action}: live state is ${format(observed)}, neither the pre-call ${format(liveBefore)} nor the selected ${format(liveSelected)} state (live apply changed during the call: ${liveApplyBefore} -> ${liveApplyAfter})`);
        }
      } else {
        if (liveApplyBefore === liveApplyAfter) {
          // One stable capability value for the report and for the reload.
          const expectedApplication = liveApplyAfter ? 'applied' : 'restart-required';
          if (result.application !== expectedApplication) {
            throw new Error(`${action}: host reported application=${result.application} although live apply was ${liveApplyAfter ? 'available' : 'unavailable'} for the whole call`);
          }
        }
        const expected = result.application === 'applied' ? liveSelected : liveBefore;
        if (!matches(expected)) {
          throw new Error(`${action}: application=${result.application} but live state is ${format(observed)}, expected ${format(expected)}`);
        }
      }
    }
    const after = await memorySha();
    await fs.access(path.join(dataRoot(), 'event-bridge.key'));
    if (after !== before) throw new Error(`${action} changed Evolution user data`);

    return {
      action,
      application: result.application,
      restartReason: result.restartReason ?? null,
      mountedBefore,
      mountedAfter: observed.mounted,
      selected,
      toolCount: observed.tools,
      memoryUnchanged: true,
      // The host's live-vs-selected decision input, recorded so a run that
      // straddles its activation is visible in the evidence instead of looking
      // like a plain `restart-required`.
      liveApplyBefore,
      liveApplyAfter,
    };
  }
}
