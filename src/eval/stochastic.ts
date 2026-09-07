// src/eval/stochastic.ts — Tier-B stochastic mediator eval.
//
// Tier A (trajectory.ts) runs each orchestrator scenario ONCE with the
// deterministic FakeDriver and hard-gates in CI. Tier B reuses the SAME harness
// and scenarios but with a second driver (a real stochastic model) run N times,
// and a second set of thresholds: it reports the τ-bench pass^k reliability
// metric plus a Wilson confidence interval, and grades arbitration quality with
// an LLM-as-judge (judge.ts). One harness, two drivers, two thresholds.
//
// Thresholds SOFT-GATE (report-only) until judge-human calibration clears a bar
// on a ~100-300 case labeled set; only then does decideGate() return "hard".
// This module is pure/offline-testable: the real driver and judge are injected.
import {
  trajectoryScenarios,
  matchTrajectory,
  checkFsm,
  type TrajectoryScenario,
} from "./trajectory.js";
import type { MediatorDriver } from "../mediator/driver.js";
import {
  scoreDimensions,
  pairwiseCompare,
  JUDGE_DIMENSIONS,
  type JudgeChat,
  type JudgeDimension,
  type PairwiseVerdict,
} from "./judge.js";

// ── pass^k (τ-bench unbiased combinatorial estimator) ────────────────────────
// Given `passes` successes out of `trials`, the probability that k independently
// drawn trials ALL pass is the unbiased estimator C(passes,k)/C(trials,k). It is
// 0 when passes<k and 1 when passes==trials, and is non-increasing in k — a
// harder reliability bar than a plain pass rate.

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let num = 1;
  for (let i = 0; i < kk; i++) num = (num * (n - i)) / (i + 1);
  return num;
}

export function estimatePassK(passes: number, trials: number, k: number): number {
  if (k <= 0 || trials <= 0 || k > trials) return 0;
  if (passes < k) return 0;
  return comb(passes, k) / comb(trials, k);
}

// ── Wilson score confidence interval ─────────────────────────────────────────
// A proper interval for a binomial proportion (unlike the naive normal
// approximation it never leaves [0,1] and stays sensible near 0/1).

export interface Interval {
  low: number;
  high: number;
}

export function wilsonInterval(successes: number, total: number, z = 1.96): Interval {
  if (total <= 0) return { low: 0, high: 0 };
  const phat = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / total + z2 / (4 * total * total))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

// ── soft-to-hard gate ────────────────────────────────────────────────────────
// Thresholds stay report-only until the judge is calibrated: its agreement with
// a human-labeled set of ~100-300 cases must clear a bar. Until then (no labels
// yet) the gate is soft and the process never fails on a threshold breach.

export interface Calibration {
  /** Judge↔human agreement (0..1) on the labeled calibration set; null = uncalibrated. */
  judgeHumanAgreement?: number | null;
  /** Number of human-labeled cases backing the agreement figure. */
  labeledCount?: number;
  /** Agreement bar to clear before hard-gating (default 0.8). */
  bar?: number;
  /** Minimum labeled cases before hard-gating (default 100, the low end of ~100-300). */
  minLabeled?: number;
}

export interface GateDecision {
  mode: "soft" | "hard";
  reason: string;
}

export function decideGate(cal: Calibration): GateDecision {
  const bar = cal.bar ?? 0.8;
  const minLabeled = cal.minLabeled ?? 100;
  const agreement = cal.judgeHumanAgreement ?? null;
  const labeled = cal.labeledCount ?? 0;
  if (agreement === null) return { mode: "soft", reason: "judge uncalibrated — no human-labeled agreement yet" };
  if (labeled < minLabeled) return { mode: "soft", reason: `only ${labeled} labeled cases (< ${minLabeled} required)` };
  if (agreement < bar) return { mode: "soft", reason: `judge↔human agreement ${agreement.toFixed(2)} < bar ${bar.toFixed(2)}` };
  return { mode: "hard", reason: `judge calibrated: agreement ${agreement.toFixed(2)} ≥ ${bar.toFixed(2)} on ${labeled} cases` };
}

// ── runner ───────────────────────────────────────────────────────────────────

export interface JudgeConfig {
  chat: JudgeChat;
}

export interface StochasticScenarioResult {
  name: string;
  passes: number;
  trials: number;
  /** pass^k for each requested k. */
  passK: Record<number, number>;
}

export interface JudgeReport {
  perDimension: Record<JudgeDimension, number>;
  pairwise: { candidate: number; reference: number; tie: number };
}

export interface StochasticScorecard {
  trials: number;
  kSet: number[];
  perScenario: StochasticScenarioResult[];
  /** Aggregate pass^k: mean across scenarios for each k. */
  passK: Record<number, number>;
  /** Wilson CI on the pooled per-trial pass rate across all scenarios. */
  ci: Interval;
  judge?: JudgeReport;
  gate: GateDecision;
}

export interface RunStochasticEvalOptions {
  /** Trials per scenario (N). Default 5. */
  trials?: number;
  /** k values for pass^k. Default [1,2,3]. */
  kSet?: number[];
  /** Override the scenario suite (defaults to the shared Tier-A scenarios). */
  scenarios?: TrajectoryScenario[];
  /** Attach the LLM-as-judge phase. */
  judge?: JudgeConfig;
  /** Calibration state feeding the soft/hard gate. */
  calibration?: Calibration;
}

/** Run one scenario once with a fresh driver; returns whether it conformed. */
async function runOnce(scenario: TrajectoryScenario, driver: MediatorDriver): Promise<{ passed: boolean; kinds: string[] }> {
  try {
    const { kinds, statePath } = await scenario.exec(driver);
    const match = await matchTrajectory(kinds, scenario.expectedKinds, scenario.matchMode);
    const fsm = checkFsm(kinds, statePath);
    const conforms = match.ok && fsm.ok;
    // For a negative-control scenario, conforming is the failure.
    const passed = scenario.negative ? !conforms : conforms;
    return { passed, kinds };
  } catch {
    return { passed: false, kinds: [] };
  }
}

export async function runStochasticEval(
  driverFactory: () => MediatorDriver,
  opts: RunStochasticEvalOptions = {},
): Promise<StochasticScorecard> {
  const trials = opts.trials ?? 5;
  const kSet = opts.kSet ?? [1, 2, 3];
  const scenarios = (opts.scenarios ?? trajectoryScenarios).filter((s) => !s.negative);

  const perScenario: StochasticScenarioResult[] = [];
  // Judge accumulators.
  const dimTotals: Record<JudgeDimension, number> = { decision_correctness: 0, rationale_grounding: 0, feedback_actionability: 0 };
  let dimCount = 0;
  const pairwise = { candidate: 0, reference: 0, tie: 0 };

  for (const scenario of scenarios) {
    let passes = 0;
    let lastKinds: string[] = [];
    for (let t = 0; t < trials; t++) {
      // Serial per trial: each exec owns a worker + sqlite handle (see harness).
      const r = await runOnce(scenario, driverFactory());
      if (r.passed) passes++;
      if (r.kinds.length > 0) lastKinds = r.kinds;
    }
    const passK: Record<number, number> = {};
    for (const k of kSet) passK[k] = estimatePassK(passes, trials, k);
    perScenario.push({ name: scenario.name, passes, trials, passK });

    if (opts.judge) {
      const jc = { scenario: scenario.name, candidateKinds: lastKinds, referenceKinds: scenario.expectedKinds };
      const scores = await scoreDimensions(opts.judge.chat, jc);
      for (const d of JUDGE_DIMENSIONS) dimTotals[d] += scores[d];
      dimCount++;
      const verdict: PairwiseVerdict = await pairwiseCompare(opts.judge.chat, jc);
      pairwise[verdict]++;
    }
  }

  // Aggregate pass^k = mean across scenarios per k.
  const passK: Record<number, number> = {};
  for (const k of kSet) {
    passK[k] = perScenario.length === 0 ? 0 : perScenario.reduce((a, s) => a + (s.passK[k] ?? 0), 0) / perScenario.length;
  }

  const pooledPasses = perScenario.reduce((a, s) => a + s.passes, 0);
  const pooledTotal = perScenario.reduce((a, s) => a + s.trials, 0);
  const ci = wilsonInterval(pooledPasses, pooledTotal);

  const judge: JudgeReport | undefined = opts.judge
    ? {
        perDimension: {
          decision_correctness: dimCount ? dimTotals.decision_correctness / dimCount : 0,
          rationale_grounding: dimCount ? dimTotals.rationale_grounding / dimCount : 0,
          feedback_actionability: dimCount ? dimTotals.feedback_actionability / dimCount : 0,
        },
        pairwise,
      }
    : undefined;

  return {
    trials,
    kSet,
    perScenario,
    passK,
    ci,
    judge,
    gate: decideGate(opts.calibration ?? {}),
  };
}
