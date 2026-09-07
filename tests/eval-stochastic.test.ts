// tests/eval-stochastic.test.ts — Tier-B stochastic mediator eval. Runs the
// SAME trajectory scenarios (src/eval/trajectory.ts) over N real-model trials,
// reports the τ-bench pass^k reliability metric + a Wilson confidence interval,
// and scores arbitration quality with a hand-rolled LLM-as-judge (per-dimension
// discrete rubric, pairwise both-orderings with flip→tie). Thresholds soft-gate
// (report-only) until judge-human calibration clears a bar. All network paths
// (real driver, judge) are injected so this suite runs fully offline in CI.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediatorDriver } from "../src/mediator/driver.js";
import { estimatePassK, wilsonInterval, decideGate, runStochasticEval } from "../src/eval/stochastic.js";
import { scoreDimensions, pairwiseCompare, JUDGE_DIMENSIONS, type JudgeChat } from "../src/eval/judge.js";
import { FakeDriver } from "../src/mediator/fake.js";
import type { TrajectoryScenario } from "../src/eval/trajectory.js";

const exec = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;

describe("pass^k estimator (τ-bench unbiased combinatorial)", () => {
  it("is 0 when passes < k", () => {
    expect(estimatePassK(0, 5, 1)).toBe(0);
    expect(estimatePassK(2, 5, 3)).toBe(0);
  });
  it("is 1 when every trial passes", () => {
    expect(estimatePassK(5, 5, 1)).toBe(1);
    expect(estimatePassK(5, 5, 3)).toBe(1);
  });
  it("is C(passes,k)/C(trials,k) in between", () => {
    expect(estimatePassK(3, 5, 1)).toBeCloseTo(0.6, 10); // 3/5
    expect(estimatePassK(4, 5, 2)).toBeCloseTo(0.6, 10); // 6/10
    expect(estimatePassK(3, 4, 2)).toBeCloseTo(0.5, 10); // 3/6
  });
  it("is monotonically non-increasing in k", () => {
    const k1 = estimatePassK(4, 6, 1);
    const k2 = estimatePassK(4, 6, 2);
    const k3 = estimatePassK(4, 6, 3);
    expect(k1).toBeGreaterThanOrEqual(k2);
    expect(k2).toBeGreaterThanOrEqual(k3);
  });
});

describe("Wilson confidence interval", () => {
  it("returns a degenerate interval for zero trials", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });
  it("brackets the point estimate and stays within [0,1]", () => {
    const ci = wilsonInterval(5, 10);
    expect(ci.low).toBeGreaterThanOrEqual(0);
    expect(ci.high).toBeLessThanOrEqual(1);
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.5);
  });
  it("keeps the upper bound below 1 even at a perfect rate", () => {
    const ci = wilsonInterval(10, 10);
    expect(ci.high).toBeLessThanOrEqual(1);
    expect(ci.low).toBeLessThan(1);
    expect(ci.low).toBeGreaterThan(0.5);
  });
});

describe("soft-to-hard gate decision", () => {
  it("soft-gates by default (no human labels)", () => {
    expect(decideGate({}).mode).toBe("soft");
  });
  it("hard-gates only when agreement clears the bar on a large enough labeled set", () => {
    expect(decideGate({ judgeHumanAgreement: 0.9, labeledCount: 150 }).mode).toBe("hard");
  });
  it("stays soft below the agreement bar", () => {
    expect(decideGate({ judgeHumanAgreement: 0.7, labeledCount: 150 }).mode).toBe("soft");
  });
  it("stays soft when too few cases are human-labeled", () => {
    expect(decideGate({ judgeHumanAgreement: 0.95, labeledCount: 50 }).mode).toBe("soft");
  });
});

describe("LLM-as-judge adapter (hand-rolled, injectable chat)", () => {
  it("parses a discrete per-dimension rubric score", async () => {
    const chat: JudgeChat = async () =>
      JSON.stringify({ decision_correctness: 5, rationale_grounding: 4, feedback_actionability: 3 });
    const scores = await scoreDimensions(chat, { scenario: "merge", candidateKinds: ["merge"], referenceKinds: ["merge"] });
    for (const d of JUDGE_DIMENSIONS) expect(Number.isInteger(scores[d])).toBe(true);
    expect(scores.decision_correctness).toBe(5);
    expect(scores.feedback_actionability).toBe(3);
  });

  it("treats a position flip as a tie (position-bias mitigation)", async () => {
    // Always answers "A" — i.e. always prefers whatever is in the first slot.
    // Ordering 1 puts the candidate first (→ candidate), ordering 2 puts the
    // reference first (→ reference): the two disagree, so the result is a tie.
    const biased: JudgeChat = async () => JSON.stringify({ winner: "A" });
    const r = await pairwiseCompare(biased, { scenario: "s", candidateKinds: ["create"], referenceKinds: ["create"] });
    expect(r).toBe("tie");
  });

  it("declares a consistent winner across both orderings", async () => {
    // Ordering 1: candidate is slot A → "A" (candidate). Ordering 2: candidate
    // is slot B → "B" (candidate). Both pick the candidate → candidate wins.
    let call = 0;
    const consistent: JudgeChat = async () => JSON.stringify({ winner: call++ === 0 ? "A" : "B" });
    const r = await pairwiseCompare(consistent, { scenario: "s", candidateKinds: ["create"], referenceKinds: ["merge"] });
    expect(r).toBe("candidate");
  });
});

describe("runStochasticEval", () => {
  const fakeFactory = () => new FakeDriver();

  it("counts passes per scenario and aggregates pass^k over N trials", async () => {
    // Deterministic scenario: FakeDriver on the real harness always accepts a
    // raw idea → ["create"]. Every trial passes, so pass^k is 1 for all k.
    const scenarios: TrajectoryScenario[] = [
      {
        name: "always-create",
        matchMode: "strict",
        expectedKinds: ["create"],
        exec: async () => ({ kinds: ["create"], statePath: ["QUEUED"] }),
      },
    ];
    const card = await runStochasticEval(fakeFactory, { trials: 5, kSet: [1, 2, 3], scenarios });
    expect(card.trials).toBe(5);
    expect(card.perScenario).toHaveLength(1);
    expect(card.perScenario[0]!.passes).toBe(5);
    expect(card.passK[1]).toBeCloseTo(1, 10);
    expect(card.passK[3]).toBeCloseTo(1, 10);
    expect(card.ci.high).toBeLessThanOrEqual(1);
    expect(card.gate.mode).toBe("soft");
  });

  it("reflects a partially-flaky scenario in pass^k and the CI", async () => {
    // exec alternates create/merge across trials → 3 of 5 pass against the
    // "create" golden. pass^1 = 3/5 = 0.6.
    let n = 0;
    const scenarios: TrajectoryScenario[] = [
      {
        name: "flaky",
        matchMode: "strict",
        expectedKinds: ["create"],
        exec: async () => ({ kinds: [n++ % 2 === 0 ? "create" : "merge"], statePath: ["QUEUED"] }),
      },
    ];
    const card = await runStochasticEval(fakeFactory, { trials: 5, kSet: [1, 2], scenarios });
    expect(card.perScenario[0]!.passes).toBe(3);
    expect(card.passK[1]).toBeCloseTo(0.6, 10);
    expect(card.ci.low).toBeGreaterThan(0);
    expect(card.ci.high).toBeLessThan(1);
  });

  it("attaches per-dimension judge scores when a judge is supplied", async () => {
    const scenarios: TrajectoryScenario[] = [
      { name: "s", matchMode: "strict", expectedKinds: ["create"], exec: async () => ({ kinds: ["create"], statePath: ["QUEUED"] }) },
    ];
    const chat: JudgeChat = async () =>
      JSON.stringify({ decision_correctness: 4, rationale_grounding: 4, feedback_actionability: 4, winner: "A" });
    const card = await runStochasticEval(fakeFactory, { trials: 2, kSet: [1], scenarios, judge: { chat } });
    expect(card.judge).toBeDefined();
    for (const d of JUDGE_DIMENSIONS) expect(card.judge!.perDimension[d]).toBeGreaterThan(0);
  });
});

describe("`pnpm eval --stochastic` without a key", () => {
  it("skips cleanly and exits 0", async () => {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    const { stdout } = await exec(
      "node",
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--stochastic"],
      { cwd: repoRoot, env, timeout: 60_000 },
    );
    expect(stdout.toLowerCase()).toContain("skip");
    expect(stdout).toContain("OPENROUTER_API_KEY");
  }, 70_000);
});
