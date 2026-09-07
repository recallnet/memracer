import { describe, expect, it } from "vitest";
import { FakeDriver } from "../src/mediator/fake.js";
import type { MediatorDriver, ReviewInput, ReviewResult } from "../src/mediator/driver.js";
import {
  classifyReviewFidelity,
  fidelityMinSample,
  hollowFeedbackNamesGap,
  reviewFidelityFixtures,
  runReviewFidelityBaselineTreatment,
  runReviewFidelityEval,
  WHOLENESS_CRITERIA,
} from "../src/eval/review-fidelity.js";
import { buildGroomPrompt, buildReviewPrompt } from "../src/mediator/prompts.js";
import { compareRates } from "../src/eval/scorecard.js";
import { significantRegression, twoProportionZTest } from "../src/eval/statistics.js";
import { buildRealDrivers, parseSamples } from "../scripts/eval-review-fidelity.js";

/** Baseline driver: never applies wholeness — only the classic "bad" marker. */
class BaselineReviewDriver implements MediatorDriver {
  async groom() { throw new Error("unused"); }
  async review(_ctx: unknown, input: ReviewInput): Promise<ReviewResult> {
    if (/\bbad\b/.test(input.plan)) {
      return { verdict: "revise", feedback: "bad", rationale: "bad" };
    }
    return { verdict: "approved", feedback: "", rationale: "baseline ignores wholeness" };
  }
  async answer() { throw new Error("unused"); }
  async discuss() { throw new Error("unused"); }
  async conciliate() { throw new Error("unused"); }
  async enhance() { throw new Error("unused"); }
  async refreshProjectKnowledge() { throw new Error("unused"); }
}

describe("review-fidelity eval", () => {
  it("has balanced hollow/whole fixtures including ungroomed hollow feature cases", () => {
    const hollow = reviewFidelityFixtures.filter((f) => f.label === "hollow");
    const whole = reviewFidelityFixtures.filter((f) => f.label === "whole");
    expect(hollow.length).toBeGreaterThanOrEqual(4);
    expect(whole.length).toBeGreaterThanOrEqual(3);
    expect(hollow.some((f) => f.hollowKind === "unwired-path")).toBe(true);
    expect(hollow.some((f) => f.name.includes("interrogation"))).toBe(true);
    const ungroomed = hollow.filter((f) => !f.task.body.includes("Wired path"));
    expect(ungroomed.length).toBeGreaterThanOrEqual(2);
    expect(ungroomed.some((f) => f.name === "historical-interrogation-unwired")).toBe(true);
  });

  it("treatment FakeDriver catches hollow plans (including ungroomed) and passes whole ones", async () => {
    const card = await runReviewFidelityEval(() => new FakeDriver());
    expect(card.cases).toBe(reviewFidelityFixtures.length);
    expect(card.hollowRecall).toBe(1);
    expect(card.wholePrecision).toBe(1);
    expect(card.clarifyRate).toBe(0);
    expect(card.passRate).toBe(1);
    const hollow = card.perCase.find((c) => c.name === "historical-interrogation-unwired");
    expect(hollow).toMatchObject({ got: "revise", hollowCaught: true, ok: true });
    const ungroomed = card.perCase.find((c) => c.name === "ungroomed-unwired-store");
    expect(ungroomed).toMatchObject({ got: "revise", hollowCaught: true, ok: true });
    const good = card.perCase.find((c) => c.name === "whole-wired-with-browser");
    expect(good).toMatchObject({ got: "approved", wholePreserved: true, ok: true });
  });

  it("baseline vs treatment scorecard shows hollow-recall lift via twoProportionZTest", async () => {
    const card = await runReviewFidelityBaselineTreatment({
      baselineDriver: () => new BaselineReviewDriver() as unknown as MediatorDriver,
      treatmentDriver: () => new FakeDriver(),
    });
    expect(card.baseline.hollowRecall).toBe(0);
    expect(card.treatment.hollowRecall).toBe(1);
    expect(card.treatment.wholePrecision).toBe(1);
    expect(card.hollowRecall.zTest.effectSize).toBeGreaterThan(0);
    expect(card.summary).toContain("hollow-recall");
    expect(card.summary).toContain("whole-precision");
    expect(card.summary).toContain("whole-clarify-rate");
  });

  it("scorecard helper computes two-proportion comparison and symmetric regression gate", () => {
    const c = compareRates(
      "demo",
      { label: "b", successes: 0, total: 10 },
      { label: "t", successes: 10, total: 10 },
      { minSample: 4, minEffect: 0.1 },
    );
    expect(c.zTest.effectSize).toBe(1);
    expect(c.significantImprovement).toBe(true);

    // Treatment drops whole-precision: regression must fire at minSample=4.
    const reg = compareRates(
      "whole-precision",
      { label: "b", successes: 10, total: 10 },
      { label: "t", successes: 0, total: 10 },
      { minSample: 4, minEffect: 0.1 },
    );
    expect(reg.significantRegression).toBe(true);
    // Default minSample=100 still inert at n=4.
    const inert = significantRegression(twoProportionZTest(0, 4, 4, 4), 4, 0.1);
    expect(inert).toBe(false);
    expect(significantRegression(twoProportionZTest(0, 4, 4, 4), 4, 0.1, 4)).toBe(true);
  });

  it("groom and review prompts carry the wholeness bar language; baseline can omit it", () => {
    const groom = buildGroomPrompt(
      { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" },
      { title: "t", body: "FEATURE: do a thing", evidence: [] },
    );
    expect(groom).toMatch(/wholeness bar|Wired path|integration or browser test/i);
    expect(groom).toContain("demonstrated working");

    const ctx = { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" };
    const input = {
      taskId: 1,
      task: { title: "t", body: WHOLENESS_CRITERIA, groomingRationale: "feature" },
      plan: "do it",
    };
    const review = buildReviewPrompt(ctx, input);
    expect(review).toMatch(/Wholeness bar/i);
    expect(review).toMatch(/scoped exception/i);
    expect(review).toMatch(/Do not revise plans for other concerns/i);

    const baseline = buildReviewPrompt(ctx, input, { wholenessBar: false });
    expect(baseline).not.toMatch(/Wholeness bar/i);
    expect(baseline).toMatch(/Do not revise plans for other concerns/i);
  });

  it("classifier requires hollow feedback to name the gap (not bare path/unit-test)", () => {
    const fixture = reviewFidelityFixtures.find((f) => f.name === "isolation-only-tests")!;
    const weak = classifyReviewFidelity(fixture, {
      verdict: "revise",
      feedback: "needs work",
      rationale: "generic",
    });
    expect(weak.hollowCaught).toBe(false);
    const wrongDirection = classifyReviewFidelity(fixture, {
      verdict: "revise",
      feedback: "add unit tests for the path",
      rationale: "more coverage",
    });
    expect(wrongDirection.hollowCaught).toBe(false);
    expect(hollowFeedbackNamesGap("add unit tests for the path")).toBe(false);
    // Real-model phrasing must count (not only the exact "wired path" bigram).
    expect(hollowFeedbackNamesGap("wire the delivery path to the live queue")).toBe(true);
    expect(hollowFeedbackNamesGap("needs a wired path end-to-end")).toBe(true);
    const strong = classifyReviewFidelity(fixture, {
      verdict: "revise",
      feedback: "Wholeness gap: only unit-tests a sub-component in isolation",
      rationale: "wholeness",
    });
    expect(strong.hollowCaught).toBe(true);
  });

  it("fidelityMinSample floors at 4 and scales with hollowTotal (not a no-op cap)", () => {
    // Bug was Math.max(4, Math.min(hB, hT, 4)) === 4 always.
    expect(fidelityMinSample(4, 4)).toBe(4);
    expect(fidelityMinSample(2, 2)).toBe(4);
    expect(fidelityMinSample(12, 12)).toBe(12);
    expect(fidelityMinSample(12, 8)).toBe(8);
  });

  it("clarifyRate.significantRegression fires on over-clarify, not under-clarify", async () => {
    class AlwaysClarify implements MediatorDriver {
      async groom() {
        throw new Error("unused");
      }
      async review(): Promise<ReviewResult> {
        return { verdict: "clarify", feedback: "need more detail", rationale: "ambiguous" };
      }
      async answer() {
        throw new Error("unused");
      }
      async discuss() {
        throw new Error("unused");
      }
      async conciliate() {
        throw new Error("unused");
      }
      async enhance() {
        throw new Error("unused");
      }
      async refreshProjectKnowledge() {
        throw new Error("unused");
      }
    }
    class AlwaysApprove implements MediatorDriver {
      async groom() {
        throw new Error("unused");
      }
      async review(): Promise<ReviewResult> {
        return { verdict: "approved", feedback: "", rationale: "ok" };
      }
      async answer() {
        throw new Error("unused");
      }
      async discuss() {
        throw new Error("unused");
      }
      async conciliate() {
        throw new Error("unused");
      }
      async enhance() {
        throw new Error("unused");
      }
      async refreshProjectKnowledge() {
        throw new Error("unused");
      }
    }
    // Whole-only fixtures keep hollowTotal=0 → minSample floors at 4; 4 whole × samples=2 = n=8.
    const wholeOnly = reviewFidelityFixtures.filter((f) => f.label === "whole");
    const overClarify = await runReviewFidelityBaselineTreatment({
      baselineDriver: () => new AlwaysApprove() as unknown as MediatorDriver,
      treatmentDriver: () => new AlwaysClarify() as unknown as MediatorDriver,
      fixtures: wholeOnly,
      samples: 2,
    });
    expect(overClarify.treatment.clarifyRate).toBe(1);
    expect(overClarify.baseline.clarifyRate).toBe(0);
    expect(overClarify.clarifyRate.significantRegression).toBe(true);
    expect(overClarify.clarifyRate.significantImprovement).toBe(false);

    const underClarify = await runReviewFidelityBaselineTreatment({
      baselineDriver: () => new AlwaysClarify() as unknown as MediatorDriver,
      treatmentDriver: () => new AlwaysApprove() as unknown as MediatorDriver,
      fixtures: wholeOnly,
      samples: 2,
    });
    expect(underClarify.clarifyRate.significantRegression).toBe(false);
    expect(underClarify.clarifyRate.significantImprovement).toBe(true);
  });

  it("wires --real driver factories and sample parsing without network", () => {
    expect(parseSamples([])).toBe(3);
    expect(parseSamples(["--samples=2"])).toBe(2);
    expect(parseSamples(["--samples=99"])).toBe(10);
    const { baselineDriver, treatmentDriver } = buildRealDrivers("test-key");
    const b = baselineDriver();
    const t = treatmentDriver();
    expect(b).toBeTruthy();
    expect(t).toBeTruthy();
    expect(b).not.toBe(t);
  });
});
