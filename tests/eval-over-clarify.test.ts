import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runOverClarifyEval } from "../src/eval/over-clarify.js";
import { buildGroomPrompt } from "../src/mediator/prompts.js";

const execFileAsync = promisify(execFile);

describe("over-clarification penalty", () => {
  it("requires zero asks on defaultable details while protecting genuine decisions", async () => {
    const card = await runOverClarifyEval();
    expect(card.defaultableCases).toBe(10);
    expect(card.clarifications).toBe(0);
    expect(card.penalty).toBe(0);
    expect(card.genuineDecisionProtected).toBe(true);
    expect(card.failed).toBe(0);
  });

  it("penalizes an ambiguity-grilling prompt regression", async () => {
    const prompt = buildGroomPrompt(
      { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" },
      { taskId: 1, title: "T", body: "B", priority: 2, submittedBy: "eval", evidence: [] },
    )
      .replace("This rule outranks the grilling posture", "Grill every ambiguity")
      .concat("\nSettle every ambiguity up front.");
    const card = await runOverClarifyEval({ transformPrompt: () => prompt });
    expect(card.clarifications).toBe(4);
    expect(card.penalty).toBe(4);
    expect(card.failed).toBeGreaterThan(0);
  });

  it("penalizes re-asking a settled decision", async () => {
    const card = await runOverClarifyEval({
      transformPrompt: (prompt) => prompt.replace(
        /Questions are only for genuine[\s\S]*?was resolved\./,
        "Questions may repeat prior decisions.",
      ),
    });
    expect(card.perCase.find((result) => result.name === "settled-decision")?.actual).toBe("clarify");
    expect(card.penalty).toBeGreaterThan(0);
    expect(card.failed).toBeGreaterThan(0);
  });

  it("is available as a deterministic CLI gate", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--over-clarify"],
      { cwd: process.cwd(), timeout: 20_000 },
    );
    expect(stdout).toContain("Over-clarification eval");
    expect(stdout).toContain("clarifications: 0");
    expect(stdout).toContain("RESULT: PASS");
  });
});
