/** Reporting, snapshot, and fitness summaries for continuous evolution. */
import { clone, finite, nowMs, timestamp } from "./shared.js";
import { metricsFitness } from "./discovery-metrics.js";
import { decisionName } from "./lineage.js";

export { metricsFitness };

export function supervisorReport(supervisor, { reports = null, cycles = 3, required = cycles } = {}) {
    const selected = (reports ?? supervisor.history).slice(-Math.max(1, Number(cycles) || 3)).map(clone);
    const lineage = selected.map((entry) => entry.lineage).filter(Boolean);
    const fitness = lineage.map((entry) => finite(entry.fitnessScore) ?? 0);
    const trend = fitness.length < 2 ? "insufficient" : fitness.every((value, index) => index === 0 || value >= fitness[index - 1]) && fitness.some((value, index) => index > 0 && value > fitness[index - 1]) ? "improving" : fitness.some((value, index) => index > 0 && value < fitness[index - 1]) ? "regressing" : "stable";
    const metricsImproved = selected.filter((entry) => {
      const before = metricsFitness(entry.metricsBefore);
      const after = metricsFitness(entry.metricsAfter);
      return after > before;
    }).length;
    const rollbackReports = selected.filter((entry) => ["rollback", "rolled_back", "reverted"].includes(decisionName(entry.result?.decision ?? entry.lineage?.decision))).length;
    const severeRegression = selected.some((entry) => entry.decision?.action === "analyze" || entry.status === "failed" || entry.lineage?.decision === "rollback");
    return {
      title: "DSH Continuous Evolution Report",
      complete: selected.length >= Number(required),
      count: selected.length,
      required: Number(required),
      cycles: selected,
      summary: {
        continuousImprovement: trend === "improving",
        noSevereRegression: !severeRegression,
        metricsImproved,
        memoryEffective: Boolean(supervisor.strategyMemory?.list?.().length || supervisor.memory?.snapshot?.().strategies?.length),
        rollbackNormal: rollbackReports === 0 || selected.every((entry) => entry.status !== "failed"),
      },
      trend,
      decisions: selected.map((entry) => entry.decision?.action ?? null),
      fitness,
      lineage,
      regression: severeRegression,
      rollbackCount: rollbackReports,
      generatedAt: timestamp(supervisor.clock),
    };
}

export function supervisorSnapshot(supervisor) {
    return {
      status: supervisor.running ? "running" : "stopped",
      running: supervisor.running,
      mode: supervisor.mode,
      intervalMs: supervisor.intervalMs,
      historyCount: supervisor.history.length,
      completedCycles: supervisor.completedCycles,
      maxCycles: supervisor.maxCycles,
      decisions: supervisor.decisions.slice(-20).map(clone),
      latest: clone(supervisor.history.at(-1) ?? null),
      consecutiveFailures: supervisor.consecutiveFailures,
      circuitOpen: supervisor.circuitOpen,
      startedAt: supervisor.startedAt,
      lastSuccessAt: supervisor.lastSuccessAt,
      lastError: supervisor.lastError,
    };

}

export function trialReport(supervisor, { reports = null, cycles = null, required = null } = {}) {
    const source = (reports ?? supervisor.history).filter(Boolean);
    const selected = cycles === null ? source.map(clone) : source.slice(-Math.max(1, Number(cycles) || 1)).map(clone);
    const fitness = selected.map((entry) => finite(entry.fitness) ?? 0);
    const improving = fitness.length > 1 && fitness.every((value, index) => index === 0 || value >= fitness[index - 1]) && fitness.some((value, index) => index > 0 && value > fitness[index - 1]);
    const regressing = fitness.some((value, index) => index > 0 && value < fitness[index - 1]);
    const orphanDetectedCount = selected.reduce((sum, entry) => sum + Number(entry.failureIsolation?.detectedOrphanComponents ?? 0) + Number(entry.failureIsolation?.detectedOrphanEffects ?? 0), 0);
    const orphanCount = selected.reduce((sum, entry) => sum + Number(entry.failureIsolation?.orphanCount ?? 0), 0);
    const registryCorruption = selected.some((entry) => entry.failureIsolation?.registryCorruption || entry.failureIsolation?.registryCorruptionDetected);
    const memoryPollution = selected.some((entry) => entry.failureIsolation?.memoryPollution);
    const failureCount = selected.filter((entry) => entry.status === "failed" || entry.timeout || entry.rollback?.status === "rollback_failed").length;
    const resource = {
      token: selected.map((entry) => entry.resourceMetrics?.token).filter((value) => value !== null && value !== undefined),
      latencyMs: selected.map((entry) => entry.resourceMetrics?.latencyMs).filter((value) => value !== null && value !== undefined),
      memoryBytes: selected.map((entry) => entry.resourceMetrics?.memoryBytes).filter((value) => value !== null && value !== undefined),
      storageBytes: selected.map((entry) => entry.resourceMetrics?.storageBytes).filter((value) => value !== null && value !== undefined),
    };
    const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + Number(value), 0) / values.length).toFixed(4)) : null;
    const generationSet = [...new Set(selected.map((entry) => entry.generation).filter((value) => value !== null && value !== undefined))];
    return {
      title: "DSH Long-running Stability Report",
      complete: required === null ? selected.length > 0 : selected.length >= Number(required),
      count: selected.length,
      required: required === null ? null : Number(required),
      generationCount: generationSet.length,
      cycles: selected,
      runtime: { startedAt: supervisor.startedAt, endedAt: supervisor.endedAt, durationMs: supervisor.startedAt && supervisor.endedAt ? Math.max(0, nowMs(supervisor.endedAt) - nowMs(supervisor.startedAt)) : null },
      stability: { crashes: supervisor.crashes, orphanComponents: orphanCount, orphanDetectedCount, orphanComponentFree: orphanCount === 0, registryCorruption, registryStable: !registryCorruption, memoryPollution, memoryStable: !memoryPollution, failureIsolationPassed: selected.every((entry) => entry.failureIsolation?.errorContained !== false && entry.failureIsolation?.registryRestored !== false) },
      evolution: { fitness, continuousImprovement: improving, regressing, oscillating: !improving && !regressing && fitness.length > 2 ? new Set(fitness).size < fitness.length : false, rollbackCount: selected.filter((entry) => entry.rollback?.status === "rolled_back").length, failureCount },
      resources: { samples: resource, average: Object.fromEntries(Object.entries(resource).map(([key, values]) => [key, average(values)])) },
      stopCondition: { stopped: supervisor.stopRequested, reason: supervisor.stopReason, maxCycles: supervisor.maxCycles, maxConsecutiveFailures: supervisor.maxConsecutiveFailures, maxRegressions: supervisor.maxRegressions, maxRollbacks: supervisor.maxRollbacks, rollbackAttempts: supervisor.rollbackAttempts },
      generatedAt: timestamp(supervisor.clock),
    };
}

export function trialSnapshot(supervisor) {
    return {
      status: supervisor.running ? "running" : supervisor.stopRequested ? "stopped" : "ready",
      running: supervisor.running,
      bounded: true,
      cycleTimeoutMs: supervisor.cycleTimeoutMs,
      rollbackTimeoutMs: supervisor.rollbackTimeoutMs,
      rollbackAttempts: supervisor.rollbackAttempts,
      maxRollbacks: supervisor.maxRollbacks,
      maxCycles: supervisor.maxCycles,
      historyCount: supervisor.history.length,
      generationCount: new Set(supervisor.history.map((entry) => entry.generation)).size,
      consecutiveFailures: supervisor.consecutiveFailures,
      regressions: supervisor.regressions,
      crashes: supervisor.crashes,
      stopRequested: supervisor.stopRequested,
      stopReason: supervisor.stopReason,
      startedAt: supervisor.startedAt,
      endedAt: supervisor.endedAt,
      latest: clone(supervisor.history.at(-1) ?? null),
      strategyEvolutionTree: supervisor.strategyMutator?.tree?.() ?? [],
    };

}
