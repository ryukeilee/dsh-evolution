/**
 * Acceptance probe: the official DSH body still boots with this bundle
 * uninstalled, and the Evolution surface is completely absent.
 */
export const inject = ['tools'];

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

  async function run() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const evolutionTools = ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).length;
    return {
      bodyOk: Boolean(ctx.get('tools')),
      evolutionAbsent: !ctx.get('evolution'),
      evolutionTools,
    };
  }
}
