import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runOutputReliabilityEval } from "../src/eval/output-reliability.js";

const execFileAsync = promisify(execFile);

describe("output-reliability eval", () => {
  it("recovers every live signature with bounded requests and metering", async () => {
    const card = await runOutputReliabilityEval({ simulatedMinutes: 60 });

    expect(card).toMatchObject({
      cases: 60,
      simulatedMinutes: 60,
      failedJobs: 0,
      requests: 75,
      completionCount: 75,
    });
    expect(card.perCase.map((result) => [result.signature, result.jobs, result.ok])).toEqual([
      ["xml-wrapper", 15, true],
      ["truncated-json", 15, true],
      ["duplicate-set", 15, true],
      ["over-length-reason", 15, true],
    ]);
  });

  it("fails the gate when a scripted signature remains malformed", async () => {
    const card = await runOutputReliabilityEval({
      simulatedMinutes: 1,
      mutate: () => [{ content: "not JSON" }, { content: "still not JSON" }],
    });

    expect(card.failedJobs).toBeGreaterThan(0);
    expect(card.perCase.find((result) => result.signature === "xml-wrapper")).toMatchObject({ ok: false });
  });

  it("is available as a standalone hard gate", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--output-reliability"],
      { cwd: process.cwd(), timeout: 30_000 },
    );

    expect(stdout).toContain("Output-reliability eval");
    expect(stdout).toContain("failed jobs: 0");
    expect(stdout).toContain("metered completions: 75");
    expect(stdout).toContain("RESULT: PASS");
  });
});
