// tests/eval-pipeline.test.ts — pipeline-level eval: fixtures drive groom/review/answer
// through the real pipelines + worker (registerPipelines over sqlite), not driver isolation.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FakeDriver } from "../src/mediator/fake.js";
import { pipelineFixtures, runPipelineEval } from "../src/eval/pipeline.js";

const exec = promisify(execFile);

describe("pipeline eval suite", () => {
  it("covers the two shipped regressions as named fixtures", () => {
    const names = pipelineFixtures.map((f) => f.name);
    // Regression 1: mediator hallucinated a merge target (own id / nonexistent id) — pipeline
    // must fall back to accept instead of crashing or corrupting the queue.
    expect(names).toContain("regression-self-merge-target");
    expect(names).toContain("regression-hallucinated-merge-target");
    // Regression 2: the task under grooming leaked into its own context, inviting self-merge.
    expect(names).toContain("regression-groom-context-excludes-self");
  });

  it("covers groom, review, and answer flows including clarify", () => {
    const names = pipelineFixtures.map((f) => f.name);
    for (const expected of [
      "groom-accept",
      "groom-merge-valid",
      "groom-clarify-flow",
      "groom-accept-chore-untouched",
      "groom-infer-silently",
      "groom-borderline-inferable-gap-accepts",
      "groom-askback-vague-feature",
      "groom-feature-fact-gap-self-served",
      "groom-feature-with-research-accepts",
      "groom-bugfix-never-gated",
      "groom-guard-research-only-bounces",
      "groom-guard-research-then-fix-accepts",
      "groom-guard-held-scope-bounces",
      "groom-guard-held-scope-fix-passes-through",
      "groom-guard-merge-into-DONE-falls-back",
      "review-approve",
      "review-revise",
      "answer-direct",
      "answer-escalate",
      "answer-steward-close-own-task",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("passes every fixture with the deterministic FakeDriver (CI-style local run)", async () => {
    const card = await runPipelineEval(() => new FakeDriver());
    expect(card.perCase.length).toBe(pipelineFixtures.length);
    const failures = card.perCase.filter((c) => !c.ok);
    expect(failures).toEqual([]);
    expect(card.failed).toBe(0);
    expect(card.passed).toBe(pipelineFixtures.length);
  });

  it("scores a failing fixture as failed with its failure messages", async () => {
    const card = await runPipelineEval(() => new FakeDriver(), {
      fixtures: [
        {
          name: "always-fails",
          exec: async () => ["expected X, got Y"],
        },
      ],
    });
    expect(card.failed).toBe(1);
    expect(card.passed).toBe(0);
    expect(card.perCase[0]).toMatchObject({ name: "always-fails", ok: false, failures: ["expected X, got Y"] });
  });

  it("surfaces a fixture crash as a failure instead of aborting the run", async () => {
    const card = await runPipelineEval(() => new FakeDriver(), {
      fixtures: [
        { name: "boom", exec: async () => { throw new Error("harness exploded"); } },
        { name: "fine", exec: async () => [] },
      ],
    });
    expect(card.failed).toBe(1);
    expect(card.passed).toBe(1);
    const boom = card.perCase.find((c) => c.name === "boom")!;
    expect(boom.ok).toBe(false);
    expect(boom.failures[0]).toMatch(/harness exploded/);
  });

  it("`pnpm eval --pipeline` runs the suite end-to-end and exits 0", async () => {
    const { stdout } = await exec(
      "node",
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--pipeline"],
      { cwd: new URL("..", import.meta.url).pathname, timeout: 60_000 },
    );
    expect(stdout).toContain("RESULT: PASS");
    expect(stdout).toContain("regression-self-merge-target");
  }, 70_000);
});
