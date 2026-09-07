// tests/eval-trajectory.test.ts — trajectory-level eval: scenarios drive
// multi-step orchestrator runs through the real Queue + worker (registerPipelines
// over sqlite) with the deterministic FakeDriver, match the ordered action
// trajectory against golden references (agentevals), and check the primary
// task's state path for FSM reachability. Gates in CI like eval-pipeline.test.ts.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FakeDriver } from "../src/mediator/fake.js";
import {
  checkFsm,
  matchTrajectory,
  runTrajectoryEval,
  trajectoryScenarios,
} from "../src/eval/trajectory.js";

const exec = promisify(execFile);

describe("trajectory eval suite", () => {
  it("covers at least 8 golden orchestrator scenarios plus a negative control", () => {
    const golden = trajectoryScenarios.filter((s) => !s.negative);
    expect(golden.length).toBeGreaterThanOrEqual(8);
    const names = trajectoryScenarios.map((s) => s.name);
    for (const expected of [
      "accept",
      "merge",
      "clarify-then-answer-then-accept",
      "review-approve",
      "review-revise-stays-CLAIMED",
      "answer-escalate",
      "close-own-task",
      "warming-enhance-then-seal",
    ]) {
      expect(names).toContain(expected);
    }
    const negatives = trajectoryScenarios.filter((s) => s.negative);
    expect(negatives.length).toBeGreaterThanOrEqual(1);
  });

  it("passes every scenario with the deterministic FakeDriver (CI-style local run)", async () => {
    const card = await runTrajectoryEval(() => new FakeDriver());
    expect(card.perCase.length).toBe(trajectoryScenarios.length);
    const failures = card.perCase.filter((c) => !c.ok);
    expect(failures).toEqual([]);
    expect(card.failed).toBe(0);
    expect(card.passed).toBe(trajectoryScenarios.length);
  });

  it("matches golden trajectories and rejects a wrong sequence (agentevals adapter)", async () => {
    expect((await matchTrajectory(["clarify", "create"], ["clarify", "create"], "strict")).ok).toBe(true);
    expect((await matchTrajectory(["revise"], ["approve"], "strict")).ok).toBe(false);
    // unordered mode ignores order; subset mode allows a prefix/subset reference.
    expect((await matchTrajectory(["create", "merge"], ["merge", "create"], "unordered")).ok).toBe(true);
    expect((await matchTrajectory(["create", "merge"], ["merge", "create"], "strict")).ok).toBe(false);
  });

  it("FSM check accepts legal state paths and rejects illegal ones", () => {
    expect(checkFsm(["approve"], ["QUEUED", "CLAIMED", "PLANNED"]).ok).toBe(true);
    expect(checkFsm(["merge", "create"], ["INCUBATING", "INCUBATING", "QUEUED"]).ok).toBe(true);
    // Illegal transition: QUEUED -> DONE skips CLAIMED.
    const skip = checkFsm(["approve"], ["QUEUED", "DONE"]);
    expect(skip.ok).toBe(false);
    expect(skip.failures.join(" ")).toMatch(/illegal FSM transition QUEUED -> DONE/);
    // Illegal decision kind.
    const badKind = checkFsm(["frobnicate"], ["QUEUED"]);
    expect(badKind.ok).toBe(false);
    expect(badKind.failures.join(" ")).toMatch(/illegal decision kind/);
  });

  it("scores a scenario with a wrong golden sequence as failed (negative control exercised)", async () => {
    const card = await runTrajectoryEval(() => new FakeDriver(), {
      scenarios: [
        {
          name: "wrong-golden",
          matchMode: "strict",
          expectedKinds: ["merge"], // the run produces ["create"]
          exec: async () => ({ kinds: ["create"], statePath: ["QUEUED"] }),
        },
      ],
    });
    expect(card.failed).toBe(1);
    expect(card.perCase[0]!.ok).toBe(false);
    expect(card.perCase[0]!.failures.join(" ")).toMatch(/trajectory mismatch/);
  });

  it("scores a scenario with an illegal FSM transition as failed (negative control exercised)", async () => {
    const card = await runTrajectoryEval(() => new FakeDriver(), {
      scenarios: [
        {
          name: "illegal-transition",
          matchMode: "strict",
          expectedKinds: ["approve"],
          exec: async () => ({ kinds: ["approve"], statePath: ["QUEUED", "DONE"] }),
        },
      ],
    });
    expect(card.failed).toBe(1);
    expect(card.perCase[0]!.failures.join(" ")).toMatch(/illegal FSM transition/);
  });

  it("flags a negative-control scenario that fails to trigger as a failure", async () => {
    const card = await runTrajectoryEval(() => new FakeDriver(), {
      scenarios: [
        {
          name: "negative-that-conforms",
          matchMode: "strict",
          negative: true,
          expectedKinds: ["create"], // matches the run — so the violation never triggers
          exec: async () => ({ kinds: ["create"], statePath: ["QUEUED"] }),
        },
      ],
    });
    expect(card.failed).toBe(1);
    expect(card.perCase[0]!.failures.join(" ")).toMatch(/negative control did NOT trigger/);
  });

  it("surfaces a scenario crash as a failure instead of aborting the run", async () => {
    const card = await runTrajectoryEval(() => new FakeDriver(), {
      scenarios: [
        { name: "boom", matchMode: "strict", expectedKinds: ["create"], exec: async () => { throw new Error("harness exploded"); } },
        { name: "fine", matchMode: "strict", expectedKinds: ["create"], exec: async () => ({ kinds: ["create"], statePath: ["QUEUED"] }) },
      ],
    });
    expect(card.failed).toBe(1);
    expect(card.passed).toBe(1);
    const boom = card.perCase.find((c) => c.name === "boom")!;
    expect(boom.ok).toBe(false);
    expect(boom.failures[0]).toMatch(/harness exploded/);
  });

  it("`pnpm eval --trajectory` runs the suite end-to-end and exits 0", async () => {
    const { stdout } = await exec(
      "node",
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--trajectory"],
      { cwd: new URL("..", import.meta.url).pathname, timeout: 90_000 },
    );
    expect(stdout).toContain("RESULT: PASS");
    expect(stdout).toContain("warming-enhance-then-seal");
  }, 100_000);
});
