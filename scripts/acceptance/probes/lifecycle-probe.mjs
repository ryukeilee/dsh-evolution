/**
 * Acceptance probe: the official pluginManager enable/disable lifecycle.
 *
 * The probe asserts the live-vs-selected semantics itself: `applied` must
 * change the mounted service and the registered tool count immediately, while
 * `restart-required` must only change the saved selection. Evolution user data
 * must be byte-identical before and after every action.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

  async function run() {
    const action = process.env.EVOLUTION_LIFECYCLE_ACTION || 'verify';
    const expectMountedBefore = action !== 'enable' && action !== 'reinstall';
    const expectSelectedAfter = action !== 'disable' && action !== 'uninstall';

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (Boolean(ctx.get('evolution')) === expectMountedBefore && names().length === (expectMountedBefore ? 9 : 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const mountedBefore = Boolean(ctx.get('evolution'));
    if (mountedBefore !== expectMountedBefore || names().length !== (expectMountedBefore ? 9 : 0)) {
      throw new Error(`${action}: startup state wrong (mounted=${mountedBefore}, tools=${names().length})`);
    }

    const before = await memorySha();
    let result = { application: 'applied', changed: false };
    if (action === 'disable') result = await ctx.pluginManager.setBundleEnabled('dsh-evolution', false);
    else if (action === 'enable') result = await ctx.pluginManager.setBundleEnabled('dsh-evolution', true);
    else if (action === 'verify') result = { application: 'applied', changed: false };
    else throw new Error(`unknown lifecycle action ${action}`);
    if (!['applied', 'restart-required'].includes(result.application)) throw new Error(`${action} failed: ${JSON.stringify(result)}`);

    const selected = (await ctx.pluginManager.listBundles()).some((bundle) => bundle.name === 'dsh-evolution' && bundle.enabled);
    if (selected !== expectSelectedAfter) throw new Error(`${action}: saved selection is ${selected}, expected ${expectSelectedAfter}`);

    const expectLive = result.application === 'applied' ? expectSelectedAfter : expectMountedBefore;
    if (Boolean(ctx.get('evolution')) !== expectLive || names().length !== (expectLive ? 9 : 0)) {
      throw new Error(`${action}: application=${result.application} but live state violates restart semantics`);
    }
    const after = await memorySha();
    await fs.access(path.join(dataRoot(), 'event-bridge.key'));
    if (after !== before) throw new Error(`${action} changed Evolution user data`);

    return {
      action,
      application: result.application,
      mountedBefore,
      mountedAfter: Boolean(ctx.get('evolution')),
      selected,
      toolCount: names().length,
      memoryUnchanged: true,
    };
  }
}
