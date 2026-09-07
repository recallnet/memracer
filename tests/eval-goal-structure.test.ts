import { describe, expect, it } from "vitest";
import { goalStructureFixtures, runGoalStructureEval, scoreGoalStructureBody } from "../src/eval/goal-structure.js";

describe("deterministic goal structure eval", () => {
  it("contains the five required labeled fixtures", () => {
    expect(goalStructureFixtures.map((fixture) => [fixture.name, fixture.expected])).toEqual([
      ["auth-tests-pass", "goal"],
      ["p95-under-120ms", "goal"],
      ["close-migrate-v2-issues", "goal"],
      ["rename-function", "prompt"],
      ["explain-x", "prompt"],
    ]);
  });

  it("passes actual scripted-driver groom/enhance output persisted through the real pipeline", async () => {
    const card = await runGoalStructureEval();
    expect(card.failed).toBe(0);
    expect(card.passed).toBe(5);
    expect(card.perCase.every((result) => result.ok)).toBe(true);
  });

  it("negative controls catch wrong shape, lost commands, and cap language", () => {
    const goal = goalStructureFixtures[0];
    expect(scoreGoalStructureBody(goal, goal.expectedBody.replace("Goal:", "Outcome:"))).not.toEqual([]);
    expect(scoreGoalStructureBody(goal, goal.expectedBody.replace("pnpm vitest run tests/auth", "pnpm test"))).toContain(
      "emitted body lost required text: pnpm vitest run tests/auth",
    );
    expect(scoreGoalStructureBody(goal, goal.expectedBody.replace("; PASS means", "; stop-after-3; PASS means"))).toContain(
      "emitted body contains forbidden cap language",
    );
    expect(scoreGoalStructureBody(goal, `${goal.expectedBody}\nExtra: malformed`)).not.toEqual([]);
  });
});
