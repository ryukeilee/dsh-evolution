/**
 * Benchmark probe: report one cold-start measurement from inside the host.
 *
 * It injects the public `tools` service only and waits for the state the
 * measurement names, so the numbers describe the host's own startup, not a
 * plugin's. Nothing here writes to the Evolution data root.
 */
export const inject = ['tools'];

export function apply(ctx) {
  const receive = (message) => {
    if (message !== 'run') return;
    void run().then(
      (result) => process.send?.({ result }),
      (error) => process.send?.({ error: String(error?.stack || error) }),
    );
  };
  ctx.effect(() => {
    process.on('message', receive);
    return () => process.off('message', receive);
  });
  process.send?.({ ready: true });

  const evolutionTools = () => ctx.tools.schemas().filter((tool) => tool.name.startsWith('evolution_')).length;

  async function run() {
    const wantEvolution = process.env.BENCH_EVOLUTION === '1';
    const wantHmr = process.env.BENCH_HMR === '1';
    const idleMs = Number(process.env.BENCH_IDLE_MS || 0);
    const deadline = Date.now() + 60000;
    let timedOut = false;
    while (Date.now() < deadline) {
      const evolutionReady = wantEvolution ? Boolean(ctx.get('evolution')) && evolutionTools() === 10 : true;
      const hmrReady = wantHmr ? Boolean(ctx.get('hmr')) : true;
      if (evolutionReady && hmrReady) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (Date.now() >= deadline) timedOut = true;
    }
    const readyAt = performance.now();
    const readyCpu = process.cpuUsage();
    const readyMemory = process.memoryUsage();
    await new Promise((resolve) => setImmediate(resolve));
    let idle = null;
    if (idleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, idleMs));
      const cpu = process.cpuUsage(readyCpu);
      const memory = process.memoryUsage();
      idle = {
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        rssMiB: memory.rss / 1048576,
        heapUsedMiB: memory.heapUsed / 1048576,
      };
    }
    return {
      node: process.version,
      readyMs: readyAt,
      timedOut,
      hmr: Boolean(ctx.get('hmr')),
      evolution: Boolean(ctx.get('evolution')),
      evolutionTools: evolutionTools(),
      rssMiB: readyMemory.rss / 1048576,
      heapUsedMiB: readyMemory.heapUsed / 1048576,
      externalMiB: readyMemory.external / 1048576,
      cpuUserMs: readyCpu.user / 1000,
      cpuSystemMs: readyCpu.system / 1000,
      idle,
    };
  }
}
