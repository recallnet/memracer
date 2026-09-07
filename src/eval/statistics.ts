export interface SignificanceResult {
  statistic: number;
  pValue: number;
  effectSize: number;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[], average: number): number {
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

/** Two-sided Welch test with Cohen's d. The normal tail is conservative enough at the required n>=100 gate. */
export function welchTTest(candidate: number[], baseline: number[]): SignificanceResult {
  if (candidate.length < 2 || baseline.length < 2) throw new Error("Welch t-test requires at least two observations per sample");
  const candidateMean = mean(candidate);
  const baselineMean = mean(baseline);
  const candidateVariance = variance(candidate, candidateMean);
  const baselineVariance = variance(baseline, baselineMean);
  const standardError = Math.sqrt(candidateVariance / candidate.length + baselineVariance / baseline.length);
  const statistic = standardError === 0 ? (candidateMean === baselineMean ? 0 : Math.sign(candidateMean - baselineMean) * Infinity) : (candidateMean - baselineMean) / standardError;
  const pooled = Math.sqrt(((candidate.length - 1) * candidateVariance + (baseline.length - 1) * baselineVariance) / (candidate.length + baseline.length - 2));
  return {
    statistic,
    pValue: Number.isFinite(statistic) ? 2 * (1 - normalCdf(Math.abs(statistic))) : 0,
    effectSize: pooled === 0 ? (candidateMean === baselineMean ? 0 : Math.sign(candidateMean - baselineMean) * Infinity) : (candidateMean - baselineMean) / pooled,
  };
}

export function twoProportionZTest(
  candidateSuccesses: number,
  candidateTotal: number,
  baselineSuccesses: number,
  baselineTotal: number,
): SignificanceResult {
  if (candidateTotal <= 0 || baselineTotal <= 0) throw new Error("proportion test totals must be positive");
  const candidateRate = candidateSuccesses / candidateTotal;
  const baselineRate = baselineSuccesses / baselineTotal;
  const pooled = (candidateSuccesses + baselineSuccesses) / (candidateTotal + baselineTotal);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / candidateTotal + 1 / baselineTotal));
  const statistic = standardError === 0 ? (candidateRate === baselineRate ? 0 : Math.sign(candidateRate - baselineRate) * Infinity) : (candidateRate - baselineRate) / standardError;
  return {
    statistic,
    pValue: Number.isFinite(statistic) ? 2 * (1 - normalCdf(Math.abs(statistic))) : 0,
    effectSize: candidateRate - baselineRate,
  };
}

/**
 * True when treatment is a significant regression vs baseline.
 * `minSample` defaults to 100 for high-bar release gates; scorecard arms that
 * run small fixture suites pass their own minSample (e.g. 4) so the guard is
 * not asymmetrically inert vs significantImprovement.
 */
export function significantRegression(
  result: SignificanceResult,
  sampleSize: number,
  minimumEffect: number,
  minSample = 100,
): boolean {
  return sampleSize >= minSample && result.pValue < 0.05 && result.effectSize <= -Math.abs(minimumEffect);
}

export interface RolloutDecision {
  mode: "shadow" | "canary";
  canaryPercent: number;
  drift: number;
  action: "continue" | "rollback";
  reason: string;
}

export function decideRollout(input: {
  mode: "shadow" | "canary";
  canaryPercent?: number;
  baselinePassRate: number;
  candidatePassRate: number;
  rollbackDrift?: number;
}): RolloutDecision {
  const canaryPercent = input.mode === "shadow" ? 0 : input.canaryPercent ?? 1;
  if (input.mode === "canary" && (canaryPercent < 1 || canaryPercent > 5)) {
    throw new Error("canaryPercent must be from 1 to 5");
  }
  const drift = input.baselinePassRate - input.candidatePassRate;
  const rollbackDrift = input.rollbackDrift ?? 0.025;
  return drift > rollbackDrift
    ? { mode: input.mode, canaryPercent, drift, action: "rollback", reason: `quality drift ${(drift * 100).toFixed(2)}pp exceeds ${(rollbackDrift * 100).toFixed(2)}pp` }
    : { mode: input.mode, canaryPercent, drift, action: "continue", reason: "quality drift is within the rollout budget" };
}
