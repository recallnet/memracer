import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runOverMintEval } from "../src/eval/over-mint.js";

const execFileAsync = promisify(execFile);

describe("over-mint penalty", () => {
  it("requires grep-then-update for an existing home and justified grep/no-match before a legitimate mint", async () => {
    const card = await runOverMintEval();
    expect(card.cases).toBe(2);
    expect(card.overMints).toBe(0);
    expect(card.penalty).toBe(0);
    expect(card.promptFailures).toEqual([]);
    expect(card.failed).toBe(0);

    const existing = card.perCase.find((result) => result.name === "existing-home-grep-then-update")!;
    expect(existing.trace.map((step) => step.kind === "tool" ? step.name : step.kind)).toEqual([
      "okf_grep",
      "okf_read",
      "okf_update",
    ]);
    expect(existing.paths).toEqual(["tech/mediator-memory.md"]);
    expect(existing.audit).toEqual(["Updated knowledge: tech/mediator-memory.md"]);
    expect(existing.trace[0]).toMatchObject({
      kind: "tool",
      name: "okf_grep",
      result: { matches: [expect.objectContaining({ path: "tech/mediator-memory.md" })] },
    });
    expect(existing.minted).toBe(false);

    const novel = card.perCase.find((result) => result.name === "legitimate-new-concept")!;
    expect(novel.trace).toEqual([
      expect.objectContaining({ kind: "tool", name: "okf_grep", result: { matches: [] } }),
      expect.objectContaining({ kind: "reasoning", content: expect.stringMatching(/independent durable convention.*no matching home/i) }),
      expect.objectContaining({ kind: "tool", name: "okf_write", result: expect.objectContaining({ ok: true }) }),
    ]);
    expect(novel.paths).toEqual([
      "conventions/webhook-replay-policy.md",
      "tech/mediator-memory.md",
    ]);
    expect(novel.audit).toEqual(["Wrote knowledge: conventions/webhook-replay-policy.md"]);
    expect(novel.minted).toBe(true);
  });

  it("fails at zero tolerance when the grep/update/justification policy is weakened", async () => {
    const card = await runOverMintEval({
      transformPrompt: (prompt) => prompt
        .replace("before EVERY okf_write, call okf_grep", "consider okf_grep before okf_write")
        .replace("use okf_update; okf_write is forbidden", "either update or write a concept")
        .replace("explicitly justify why no existing concept can own it", "briefly note the new concept"),
    });
    expect(card.overMints).toBe(2);
    expect(card.penalty).toBe(2);
    expect(card.failed).toBeGreaterThan(0);
    expect(card.perCase.every((result) => !result.ok)).toBe(true);
    expect(card.perCase.find((result) => result.name === "existing-home-grep-then-update")?.paths).toEqual([
      "learnings/task-205-capture.md",
      "tech/mediator-memory.md",
    ]);
  });

  it("is available as a deterministic CLI gate and runs in the default eval", async () => {
    const standalone = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--over-mint"],
      { cwd: process.cwd(), timeout: 20_000 },
    );
    expect(standalone.stdout).toContain("Over-mint eval");
    expect(standalone.stdout).toContain("over-mints: 0");
    expect(standalone.stdout).toContain("RESULT: PASS");

    const defaultRun = await execFileAsync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts"],
      { cwd: process.cwd(), timeout: 20_000 },
    );
    expect(defaultRun.stdout).toContain("Over-mint eval");
    expect(defaultRun.stdout).toContain("over-mints: 0");
    expect(defaultRun.stdout).toContain("RESULT: PASS");
  });
});
