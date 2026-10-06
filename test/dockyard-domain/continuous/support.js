// Synthetic domain contract ports only: not Cordis execution, approval, or security isolation.
import { EvolutionMemory } from '../../../lib/dockyard-domain/memory.js';
export const authority = { assertMutation() {} };
export const evidence = {
  async metrics({ phase, input }) { return input[phase === 'before' ? 'beforeMetrics' : 'afterMetrics'] ?? {}; },
  async validateResult(result) { return result?.syntheticEvidence === true; },
};
export function memory(options = {}) { return new EvolutionMemory({ mutationAuthority: authority, ...options }); }
export function syntheticHost(execute = async () => ({ status: 'promoted' }), overrides = {}) {
  return {
    async executeCycle(input) { return { ...await execute(input), syntheticEvidence: true }; },
    inspectState() { return { components: [], effects: [], invariants: { valid: true, violations: [] } }; },
    async rollback() { return { syntheticRollback: true }; },
    async runWithDeadline(task, { timeoutMs }) {
      const controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
      // Cooperative test contract: wait for task settlement; deliberately no Promise.race.
      try {
        const value = await task(controller.signal);
        if (expired) { const error = new Error('Synthetic deadline expired'); error.code = 'ETRIALTIMEOUT'; error.timeout = true; throw error; }
        return value;
      } catch (error) {
        if (expired) { error.timeout = true; error.code = 'ETRIALTIMEOUT'; }
        throw error;
      } finally { clearTimeout(timer); }
    },
    ...overrides,
  };
}
export const proposal = { problem: 'latency candidate', confidence: 0.9, priority: 'high', estimatedBenefit: 0.4, suggested_area: 'performance' };
export function generation(generation) {
  return {
    generation,
    samples: [
      { successRate: .96, latencyMs: 100, cost: 10, tokenUsage: 100, qualityScore: .92 },
      { successRate: .86, latencyMs: 130, cost: 12, tokenUsage: 112, qualityScore: .84 },
      { successRate: .72, latencyMs: 170, cost: 15, tokenUsage: 126, qualityScore: .73 },
    ],
    beforeMetrics: { successRate: .76 + generation * .002, latencyMs: 180 - generation, cost: 15, tokenUsage: 128, qualityScore: .74, memoryBytes: 1024, storageBytes: 2048 },
    afterMetrics: { successRate: .77 + generation * .002, latencyMs: 175 - generation, cost: 14, tokenUsage: 126, qualityScore: .75, memoryBytes: 1024, storageBytes: 2048 },
  };
}
