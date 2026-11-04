/**
 * Acceptance probe: the host's live-apply capability race (diagnosis only).
 *
 * The official plugin manager decides both the `application` it reports and
 * whether a bundle switch reaches the live tree from one service,
 * `ctx.get('hmr')`: `PluginManager.change()` snapshots the capability before
 * writing the profile, while `configure()` and `reload()` re-read it after that
 * write to choose and perform the live application. The HMR service is only
 * observable once its asynchronous init completes, so a boot in which the
 * Evolution entry is already live while `hmr` is still initializing makes a
 * single `setBundleEnabled()` call straddle the transition: the report is the
 * older snapshot (`restart-required`) and the change is applied live anyway.
 *
 * This probe reproduces that window and reports what the host did; it is not
 * part of the acceptance flow. `docs/evidence/lifecycle-live-apply-race.md`
 * records the measurements and what `scripts/acceptance/probes/lifecycle-probe.mjs`
 * asserts instead.
 *
 * `EVOLUTION_RACE_MODE`:
 *   - `order`  — report when `evolution` and `hmr` become live, and which came
 *                first. Reads nothing, writes nothing.
 *   - `switch` — call `setBundleEnabled('dsh-evolution', false)` the instant the
 *                Evolution entry is live, and report the host's report next to
 *                the capability before/after and the resulting live tree.
 *                `preFixConsistent` applies the assertion the probe used before
 *                the fix, so a `false` there is exactly the recorded failure.
 *                This mode disables the bundle in the profile: re-enable it (or
 *                use a throwaway `$DSH_HOME`) before the next boot.
 */
export const inject = ['pluginManager', 'tools'];

/** The tool surface the bundle registers (lib/registration.js#EVOLUTION_TOOLS). */
const EVOLUTION_TOOL_COUNT = 10;
const EVOLUTION_TOOL_PREFIX = 'evolution_';

export function apply(ctx) {
  const started = Date.now();
  const mode = process.env.EVOLUTION_RACE_MODE || 'order';
  const names = () => ctx.tools.schemas().filter((tool) => tool.name.startsWith(EVOLUTION_TOOL_PREFIX)).map((tool) => tool.name);
  const evolutionLive = () => Boolean(ctx.get('evolution')) && names().length === EVOLUTION_TOOL_COUNT;
  const liveApplyAvailable = () => ctx.get('hmr') !== undefined;

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

  async function run() {
    if (mode === 'order') return order();
    if (mode === 'switch') return switchBundle();
    throw new Error(`unknown EVOLUTION_RACE_MODE ${mode}`);
  }

  /** Sample both services until each is live; report the order and the gap. */
  async function order() {
    let evolutionAt = null;
    let liveApplyAt = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && (evolutionAt === null || liveApplyAt === null)) {
      if (evolutionAt === null && evolutionLive()) evolutionAt = Date.now() - started;
      if (liveApplyAt === null && liveApplyAvailable()) liveApplyAt = Date.now() - started;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return {
      mode,
      evolutionLiveAtMs: evolutionAt,
      liveApplyAvailableAtMs: liveApplyAt,
      first: evolutionAt === null || liveApplyAt === null ? null : evolutionAt < liveApplyAt ? 'evolution' : 'live-apply',
      gapMs: evolutionAt === null || liveApplyAt === null ? null : liveApplyAt - evolutionAt,
    };
  }

  /** Switch the bundle the moment the Evolution entry is live. */
  async function switchBundle() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !evolutionLive()) await new Promise((resolve) => setImmediate(resolve));
    if (!evolutionLive()) throw new Error('the Evolution entry never became live');
    const mountedBefore = Boolean(ctx.get('evolution'));
    const liveApplyBefore = liveApplyAvailable();
    const result = await ctx.pluginManager.setBundleEnabled('dsh-evolution', false);
    const liveApplyAfter = liveApplyAvailable();
    const mountedAfter = Boolean(ctx.get('evolution'));
    const toolsAfter = names().length;
    // The pre-fix assertion: `restart-required` must leave the live tree alone.
    const expectLive = result.application === 'applied' ? false : mountedBefore;
    return {
      mode,
      application: result.application,
      liveApplyBefore,
      liveApplyAfter,
      mountedBefore,
      mountedAfter,
      toolsAfter,
      preFixConsistent: mountedAfter === expectLive && toolsAfter === (expectLive ? EVOLUTION_TOOL_COUNT : 0),
    };
  }
}
