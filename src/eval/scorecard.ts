/**
 * One-shot baseline vs treatment rate comparison via twoProportionZTest.
 * Not a persisted multi-release measurement platform — no scorecard store,
 * no release tracking, no alert loop. On-demand helper for eval scripts/CI.
 */
import { significantRegression, twoProportionZTest, type SignificanceResult } from "./statistics.js";

export interface ArmRate {
  label: string;
  successes: number;
  total: number;
}

export interface RateComparison {
  metric: string;
  baseline: ArmRate;
  treatment: ArmRate;
  zTest: SignificanceResult;
  /** True when treatment rate is significantly higher than baseline (improvement). */
  significantImprovement: boolean;
  /** True when treatment is a significant regression vs baseline. */
  significantRegression: boolean;
}

export function compareRates(
  metric: string,
  baseline: ArmRate,
  treatment: ArmRate,
  opts: { minSample?: number; minEffect?: number } = {},
): RateComparison {
  const minSample = opts.minSample ?? 20;
  const minEffect = opts.minEffect ?? 0.05;
  const zTest = twoProportionZTest(
    treatment.successes,
    treatment.total,
    baseline.successes,
    baseline.total,
  );
  const sample = Math.min(baseline.total, treatment.total);
  const improvement =
    sample >= minSample &&
    zTest.pValue < 0.05 &&
    zTest.effectSize >= Math.abs(minEffect);
  // Same sample gate as improvement — do not leave regression inert at n=4.
  const regression = significantRegression(zTest, sample, minEffect, minSample);
  return {
    metric,
    baseline,
    treatment,
    zTest,
    significantImprovement: improvement,
    significantRegression: regression,
  };
}

export function formatRateComparison(c: RateComparison): string {
  const bRate = c.baseline.total ? c.baseline.successes / c.baseline.total : 0;
  const tRate = c.treatment.total ? c.treatment.successes / c.treatment.total : 0;
  const flag = c.significantImprovement
    ? "IMPROVED"
    : c.significantRegression
      ? "REGRESSED"
      : "ns";
  return [
    `${c.metric}: ${c.baseline.label}=${(bRate * 100).toFixed(1)}% (${c.baseline.successes}/${c.baseline.total})`,
    `→ ${c.treatment.label}=${(tRate * 100).toFixed(1)}% (${c.treatment.successes}/${c.treatment.total})`,
    `Δ=${(c.zTest.effectSize * 100).toFixed(1)}pp z=${c.zTest.statistic.toFixed(2)} p=${c.zTest.pValue.toFixed(4)} [${flag}]`,
  ].join(" ");
}
