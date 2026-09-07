import { describe, expect, it } from "vitest";
import { qualifyMediatorRouting, runRoutingToolQualification } from "../src/eval/routing-qualification.js";
import { FakeDriver } from "../src/mediator/fake.js";

function quality(passed: number, overrides: Record<string, number> = {}) {
  return {
    cases: 100,
    passed,
    passRate: passed / 100,
    judgeBudgetExhausted: false,
    metrics: {
      scopeCorrectness: 1,
      clarificationCorrectness: 1,
      decisionConsistency: 1,
      jsonValidity: 1,
      toolLoopSuccess: 1,
      rationaleGroundedness: 1,
      ...overrides,
    },
  };
}

describe("mediator routing qualification", () => {
  it("qualifies a non-regressing 100-case candidate after 60/60 reliability", () => {
    expect(qualifyMediatorRouting({
      baseline: quality(98),
      candidate: quality(98),
      reliability: { jobs: 60, failedJobs: 0 },
      candidateTools: { off: { calls: 1, failed: false }, low: { calls: 1, failed: false } },
    })).toEqual({ qualified: true, reasons: [] });
  });

  it("refuses fewer than 100 historical cases or anything short of 60/60", () => {
    const candidate = { ...quality(98), cases: 99 };
    expect(qualifyMediatorRouting({
      baseline: quality(98), candidate,
      reliability: { jobs: 59, failedJobs: 0 },
      candidateTools: { off: { calls: 1, failed: false }, low: { calls: 1, failed: false } },
    })).toEqual({
      qualified: false,
      reasons: [
        "candidate quality corpus has 99 cases; at least 100 are required",
        "output reliability is 59/59; exactly 60/60 is required",
      ],
    });
  });

  it("refuses JSON/tool failures, judge exhaustion, and material quality regression", () => {
    const candidate = {
      ...quality(90, { jsonValidity: 0.99, toolLoopSuccess: 0.98 }),
      judgeBudgetExhausted: true,
    };
    const decision = qualifyMediatorRouting({
      baseline: quality(98), candidate,
      reliability: { jobs: 60, failedJobs: 0 },
      candidateTools: { off: { calls: 0, failed: true }, low: { calls: 1, failed: false } },
    });
    expect(decision.qualified).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "candidate structured JSON reliability is not 100%",
      "candidate tool-loop reliability is not 100%",
      "candidate judge budget was exhausted",
      expect.stringMatching(/quality pass rate regressed/),
      "candidate off-reasoning tool probe made 0 successful calls; exactly 1 is required",
    ]));
  });

  it("observes exactly one dispatched candidate tool call", async () => {
    const driver = new FakeDriver();
    driver.answer = async (ctx) => {
      await ctx.tools?.dispatch("qualification_probe", { nonce: "memracer-routing-qualification" });
      return { escalate: false, answer: "probe completed", rationale: "qualified" };
    };
    await expect(runRoutingToolQualification(driver)).resolves.toEqual({ calls: 1, failed: false });
  });

  it("fails when the candidate answers without its required tool call", async () => {
    await expect(runRoutingToolQualification(new FakeDriver())).resolves.toEqual({ calls: 0, failed: true });
  });
});
