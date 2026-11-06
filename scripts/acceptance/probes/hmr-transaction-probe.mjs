/** Diagnostic only. Use reproduce-hmr-startup.mjs in a disposable official profile.
 * The barrier pauses after the real selectBundle save until real HMR init finishes.
 * It changes scheduling only; no service value, transaction guard or dependency source is replaced.
 * These private manager/ALS reads are diagnostic instrumentation, never plugin runtime dependencies.
 *
 * `no-hmr` and `no-hmr-verify` run against a profile whose `hmr` row is disabled by
 * the ordinary patch overlay: the same enable action is issued at the same moment,
 * and a second boot checks that the saved selection is what the first boot withheld.
 */
export const inject = ['pluginManager', 'loader'];

export function apply(ctx) {
  const receive = (message) => {
    if (message !== 'run') return;
    void run().then(result => process.send?.({ result }), error => process.send?.({ error: String(error.stack || error) }));
  };
  ctx.effect(() => {
    process.on('message', receive);
    return () => process.off('message', receive);
  });
  process.send?.({ ready: true });

  async function run() {
    const manager = ctx.pluginManager;
    const mode = process.env.HMR_REPRO_MODE;
    const started = Date.now();
    const events = [];
    const identities = new WeakMap();
    let nextId = 0;
    const sample = (stage) => {
      const hmr = manager.ownerContext.get('hmr');
      // Cordis wraps service reads in proxies: identify the underlying ALS, not the proxy.
      if (hmr && !identities.has(hmr.executing)) identities.set(hmr.executing, ++nextId);
      events.push({ stage, ms: Date.now() - started, hmr: Boolean(hmr),
        instance: hmr ? identities.get(hmr.executing) : null,
        inTransaction: hmr?.executing.getStore() === true });
    };
    const waitHmr = async () => {
      const deadline = Date.now() + 10000;
      while (!manager.ownerContext.get('hmr') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      if (!manager.ownerContext.get('hmr')) throw new Error('HMR did not become available');
    };
    const originals = new Map(['configure', 'reload', 'selectBundle'].map(name => [name, manager[name]]));
    try {
      for (const name of ['configure', 'reload']) {
        manager[name] = function (...args) { sample(name); return originals.get(name).apply(this, args); };
      }
      if (mode === 'barrier') {
        manager.selectBundle = async function (...args) {
          await originals.get('selectBundle').apply(this, args);
          await waitHmr();
          sample('barrier-released');
        };
      } else if (mode === 'stable') await waitHmr();
      else if (mode !== 'no-hmr' && mode !== 'no-hmr-verify') throw new Error(`unknown mode ${mode}`);
      sample('before');
      const selectedOf = async () => (await manager.listBundles()).filter(bundle => bundle.enabled).map(bundle => bundle.name);
      if (mode === 'no-hmr-verify') {
        const deadline = Date.now() + 20000;
        while (!manager.ownerContext.get('webStartup') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        const evolutionEntries = [...ctx.loader.entries()].filter(entry => String(entry.options.name).includes('dsh-evolution')).length;
        return {
          mode,
          results: [{ webStartup: Boolean(manager.ownerContext.get('webStartup')) }],
          events,
          evolutionEntries,
          selected: await selectedOf(),
        };
      }
      const results = [];
      // Compare the identical enable action under two scheduling conditions.
      results.push(await manager.setBundleEnabled('@deepseek-ai/dsh-web-app', true));
      sample('after');
      const evolutionEntries = [...ctx.loader.entries()].filter(entry => String(entry.options.name).includes('dsh-evolution')).length;
      const selected = await selectedOf();
      return { mode, results, events, evolutionEntries, selected };
    } finally {
      for (const [name, original] of originals) manager[name] = original;
    }
  }
}
