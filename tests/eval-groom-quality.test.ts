import { describe, expect, it } from "vitest";
import { FakeDriver } from "../src/mediator/fake.js";
import { loadGroomQualityCorpus, runGroomQualityEval } from "../src/eval/groom-quality.js";
import { decideRollout, significantRegression, twoProportionZTest, welchTTest } from "../src/eval/statistics.js";

describe("groom-quality eval", () => {
  it("loads a balanced 100-case historical corpus and produces the complete score report", async () => {
    const corpus = loadGroomQualityCorpus();
    expect(corpus).toHaveLength(100);
    expect(corpus.filter((item) => item.category === "happy")).toHaveLength(60);
    expect(corpus.filter((item) => item.category === "edge")).toHaveLength(20);
    expect(corpus.filter((item) => item.category === "clarify_refusal")).toHaveLength(10);
    expect(corpus.filter((item) => item.category === "historical_failure")).toHaveLength(10);

    const card = await runGroomQualityEval(() => new FakeDriver());
    expect(card.cases).toBe(100);
    expect(Object.keys(card.metrics).sort()).toEqual([
      "clarificationCorrectness", "decisionConsistency", "jsonValidity",
      "rationaleGroundedness", "scopeCorrectness", "toolLoopSuccess",
    ]);
    expect(card.passRate).toBe(1);
    expect(card.statisticalGate.regression).toBe(false);
  });

  it("calls the frontier judge only on classifier disagreement and enforces the $0.20 budget", async () => {
    let classifications = 0;
    const oneDisagreement = await runGroomQualityEval(() => new FakeDriver(), {
      classifier: { async classify({ deterministic }) { return { pass: classifications++ === 0 ? false : Object.values(deterministic).every(Boolean) }; } },
      judge: { maxCostPerCallUsd: 0.01, async judge() { return { pass: true, costUsd: 0.01 }; } },
    });
    expect(oneDisagreement.judgeCalls).toBe(1);
    expect(oneDisagreement.judgeCostUsd).toBeCloseTo(0.01);

    const capped = await runGroomQualityEval(() => new FakeDriver(), {
      classifier: { async classify() { return { pass: false }; } },
      judge: { maxCostPerCallUsd: 0.05, async judge() { return { pass: true, costUsd: 0.05 }; } },
    });
    expect(capped.judgeCalls).toBe(4);
    expect(capped.judgeCostUsd).toBeCloseTo(0.20);
    expect(capped.judgeBudgetExhausted).toBe(true);
    expect(capped.perCase.some((item) => item.error?.includes("budget"))).toBe(true);
  });
});

describe("quality statistics and rollout policy", () => {
  it("detects statistically significant regressions with effect-size and sample gates", () => {
    const proportion = twoProportionZTest(80, 100, 98, 100);
    expect(proportion.pValue).toBeLessThan(0.05);
    expect(significantRegression(proportion, 100, 0.02)).toBe(true);
    expect(significantRegression(proportion, 99, 0.02)).toBe(false);

    const welch = welchTTest(Array(100).fill(0.7), Array(100).fill(0.95));
    expect(welch.pValue).toBe(0);
    expect(welch.effectSize).toBeLessThan(0);
  });

  it("scaffolds shadow and 1-5% canary rollback on quality drift", () => {
    expect(decideRollout({ mode: "shadow", baselinePassRate: 0.98, candidatePassRate: 0.94 }).action).toBe("rollback");
    expect(decideRollout({ mode: "canary", canaryPercent: 5, baselinePassRate: 0.98, candidatePassRate: 0.97 }).action).toBe("continue");
    expect(() => decideRollout({ mode: "canary", canaryPercent: 6, baselinePassRate: 1, candidatePassRate: 1 })).toThrow(/1 to 5/);
  });
});
