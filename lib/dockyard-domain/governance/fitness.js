import { ValidationError } from "../errors.js";
import { clamp01 } from "./helpers.js";
export const FITNESS_WEIGHTS = Object.freeze({
  usageFrequency: 0.20,
  successRate: 0.25,
  userFeedback: 0.10,
  errorRate: 0.15,
  latency: 0.10,
  resourceCost: 0.10,
  maintenanceCost: 0.10,
});

const CODE_SIZE_METRIC_PATTERN = /\b(loc|lines?[-_ ]?of[-_ ]?code|code[-_]?(size|count|lines)|sloc)\b/i;

export function isLegitimateImprovementMetric(name) {
  return !CODE_SIZE_METRIC_PATTERN.test(String(name ?? ""));
}

/** 「代码更少」永远不构成改进依据；只接受方向性长期指标。 */
export function assertLegitimateImprovementMetrics(expected = {}) {
  const illegitimate = Object.keys(expected ?? {}).filter((name) => !isLegitimateImprovementMetric(name));
  if (illegitimate.length > 0) {
    throw new ValidationError("Code size is not a real improvement metric", {
      reason: "code_size_is_not_a_real_improvement",
      illegitimateMetrics: illegitimate,
    });
  }
  return true;
}

/**
 * fitness ∈ [0,1]。未知质量指标取中性 0.5；使用频率按实际计数归一化。
 * 只看使用频率、成功率、用户反馈、错误率、延迟、资源消耗、维护成本。
 */
export function computeFitnessScore(metrics = {}, options = {}) {
  const weights = { ...FITNESS_WEIGHTS, ...(options.weights ?? {}) };
  const usageNorm = Math.max(1, Number(options.usageNormCount) || 50);
  const latencyCeilingMs = Math.max(1, Number(options.latencyCeilingMs) || 5_000);
  const resourceCeiling = Math.max(1, Number(options.resourceCeiling) || 100);
  const neutral = 0.5;

  const successRate = clamp01(metrics.successRate);
  const errorRate = clamp01(metrics.errorRate) ?? (successRate === null ? null : 1 - successRate);
  const usageFrequency = clamp01((Number(metrics.usageCount) || 0) / usageNorm) ?? 0;
  const userFeedback = clamp01(metrics.userFeedback ?? metrics.avgUserFeedback);
  const latencyInput = Number(metrics.avgLatencyMs ?? metrics.latencyMs ?? NaN);
  const resourceInput = Number(metrics.avgResourceCost ?? metrics.resourceCost ?? NaN);
  const maintenanceInput = Number(metrics.maintenanceCost ?? NaN);
  const latency = Number.isFinite(latencyInput) ? clamp01(1 - Math.max(0, latencyInput) / latencyCeilingMs) : null;
  const resourceCost = Number.isFinite(resourceInput) ? clamp01(1 - Math.max(0, resourceInput) / resourceCeiling) : null;
  const maintenanceCost = Number.isFinite(maintenanceInput) ? clamp01(1 - Math.max(0, maintenanceInput)) : null;

  const factors = {
    usageFrequency: { input: metrics.usageCount ?? null, value: usageFrequency, weight: weights.usageFrequency },
    successRate: { input: metrics.successRate ?? null, value: successRate ?? neutral, weight: weights.successRate },
    userFeedback: { input: metrics.userFeedback ?? metrics.avgUserFeedback ?? null, value: userFeedback ?? neutral, weight: weights.userFeedback },
    errorRate: { input: errorRate ?? null, value: errorRate === null ? neutral : 1 - errorRate, weight: weights.errorRate },
    latency: { input: metrics.avgLatencyMs ?? metrics.latencyMs ?? null, value: latency ?? neutral, weight: weights.latency },
    resourceCost: { input: metrics.avgResourceCost ?? metrics.resourceCost ?? null, value: resourceCost ?? neutral, weight: weights.resourceCost },
    maintenanceCost: { input: metrics.maintenanceCost ?? null, value: maintenanceCost ?? neutral, weight: weights.maintenanceCost },
  };
  let score = 0;
  for (const factor of Object.values(factors)) score += factor.value * factor.weight;
  score = Math.round(Math.min(1, Math.max(0, score)) * 10_000) / 10_000;
  return { score, factors, computedAt: options.computedAt ?? null };
}

