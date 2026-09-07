import { describe, expect, it } from "vitest";
import {
  groomPostureFixtures,
  runGroomPostureEval,
  scoreGroomPosturePrompt,
} from "../src/eval/groom-posture.js";
import { buildGroomPrompt } from "../src/mediator/prompts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ctx = { projectId: "p", projectName: "P", queue: [], decisions: [], memory: "" };
const submission = { taskId: 1, ...groomPostureFixtures[0].submission };

describe("deterministic groom-posture eval", () => {
  it("covers genuine decisions, clear work, and defaultable implementation gaps", () => {
    expect(groomPostureFixtures.map(({ name, expected }) => [name, expected])).toEqual([
      ["genuine-decision", "clarify"],
      ["clear-unambiguous", "accept"],
      ["settled-decision", "accept"],
      ["discoverable-fact-gap", "accept"],
      ["icon-set", "accept"],
      ["size-cap", "accept"],
      ["ui-placement", "accept"],
      ["eval-structure", "accept"],
      ["fix-gap-markevent", "accept"],
      ["fix-required-verification-arg", "accept"],
      ["fix-metric-bug", "accept"],
      ["fix-sanitize-attention-reason", "accept"],
    ]);
  });

  it("passes the actual shared prompt through the real groom pipeline", async () => {
    const card = await runGroomPostureEval();
    expect(card.promptFailures).toEqual([]);
    expect(card.failed).toBe(0);
    expect(card.perCase.every((result) => result.ok)).toBe(true);
  });

  it("mutation controls reject missing self-service, bundled questions, and lost recommendations", async () => {
    const actual = buildGroomPrompt(ctx, submission);
    const noSelfServe = actual.replace(/SELF-SERVE FACTS[\s\S]*?Clarify ONLY/, "Clarify ONLY");
    expect(scoreGroomPosturePrompt(noSelfServe)).toContain("missing self-serve-facts instruction");
    expect((await runGroomPostureEval({ transformPrompt: () => noSelfServe })).failed).toBeGreaterThan(0);

    const noFastAccept = actual.replace("actionable core: accept it and proceed on your assumptions", "actionable core: ask before proceeding");
    expect(scoreGroomPosturePrompt(noFastAccept)).toContain("missing clear-task fast-accept instruction");
    const fastAcceptCard = await runGroomPostureEval({ transformPrompt: () => noFastAccept });
    expect(fastAcceptCard.perCase.find((result) => result.name === "clear-unambiguous")?.actual).toBe("clarify");
    expect(fastAcceptCard.failed).toBeGreaterThan(0);

    const bundled = actual.replace(/exactly ONE question per round/g, "ask at most 2 questions per round");
    expect(scoreGroomPosturePrompt(bundled)).toContain("missing one-question-per-round limit");
    expect(scoreGroomPosturePrompt(bundled)).toContain("prompt permits bundled clarification questions");
    expect((await runGroomPostureEval({ transformPrompt: () => bundled })).failed).toBeGreaterThan(0);

    const defaulted = actual.replace(/Recommended: <answer>/g, "Default: <answer>");
    expect(scoreGroomPosturePrompt(defaulted)).toContain("missing recommended-answer format");
    expect((await runGroomPostureEval({ transformPrompt: () => defaulted })).failed).toBeGreaterThan(0);

    const oldGate = `${actual}\nDid you research current best approaches? Which off-the-shelf library should we use?`;
    expect(scoreGroomPosturePrompt(oldGate)).toContain("obsolete bundled research/library gate is present");
    expect((await runGroomPostureEval({ transformPrompt: () => oldGate })).failed).toBeGreaterThan(0);

    const ambiguityCensus = actual
      .replace("This rule outranks the grilling posture", "Grill every ambiguity")
      .concat("\nSettle every ambiguity up front.");
    expect(scoreGroomPosturePrompt(ambiguityCensus)).toContain("missing agentic-default precedence over grilling");
    expect(scoreGroomPosturePrompt(ambiguityCensus)).toContain("prompt rewards clarifying every ambiguity");
    const ambiguityCard = await runGroomPostureEval({ transformPrompt: () => ambiguityCensus });
    expect(ambiguityCard.perCase.filter((result) => result.name === "icon-set")[0]?.actual).toBe("clarify");
    expect(ambiguityCard.failed).toBeGreaterThan(0);
  });

  it("fails when the real contextual package source is lost or corrupted", async () => {
    const withoutEvidence = await runGroomPostureEval({
      transformSubmission: (fixture, candidate) =>
        fixture.name === "discoverable-fact-gap" ? { ...candidate, evidence: [] } : candidate,
    });
    expect(withoutEvidence.perCase.find((result) => result.name === "discoverable-fact-gap")?.ok).toBe(false);

    const corruptedEvidence = await runGroomPostureEval({
      transformSubmission: (fixture, candidate) =>
        fixture.name === "discoverable-fact-gap"
          ? { ...candidate, evidence: candidate.evidence.map((item) => ({ ...item, snippet: "not package JSON" })) }
          : candidate,
    });
    expect(corruptedEvidence.perCase.find((result) => result.name === "discoverable-fact-gap")?.ok).toBe(false);
  });

  it("`pnpm eval --groom-posture` runs the deterministic suite", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/eval.ts", "--groom-posture"], {
      cwd: process.cwd(),
      timeout: 20_000,
    });
    expect(stdout).toContain("Groom posture eval");
    expect(stdout).toContain("RESULT: PASS");
  });
});
